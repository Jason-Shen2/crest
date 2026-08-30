# ChatGPT Subscription Provider Design

## Summary

Crest will add a first-class `openai-codex` model provider that lets a user sign in with a ChatGPT subscription and run GPT-5.6 Sol through Crest's native agent harness. Crest continues to own sessions, tool execution, permissions, context assembly, and persistence. OpenAI supplies model inference through the Codex subscription backend.

The integration will restore a Pi-compatible `openai-codex-responses` transport, keep OAuth credentials in Electron main, and discover the signed-in account's visible models dynamically. It will not embed the Codex agent or read Codex CLI credential files.

## Goals

- Add ChatGPT browser sign-in and sign-out to Crest's AI provider settings.
- Make account-visible Codex subscription models, including GPT-5.6 Sol when entitled, selectable in Crest.
- Keep access and refresh tokens out of the renderer and plaintext configuration.
- Refresh expiring credentials automatically and deduplicate concurrent refreshes.
- Preserve Crest's native JSONL sessions, tools, permissions, and agent loop.
- Fall back to a small built-in Sol/Terra/Luna catalog when account model discovery is temporarily unavailable.

## Non-goals

- Embedding or proxying the Codex App Server agent harness.
- Reading or modifying `~/.codex/auth.json` or Codex CLI keyring entries.
- Converting a ChatGPT subscription into an OpenAI Platform API key.
- Falling back automatically from subscription usage to a paid OpenAI API key.
- Deleting Crest sessions when a user signs out.
- Adding subscription support to non-Codex OpenAI endpoints.

## Architecture

The integration has four boundaries:

1. `ChatGptSubscriptionService` in Electron main owns OAuth, encrypted credential persistence, token refresh, authentication state, and account model discovery.
2. `openai-codex-responses` in `@crest/ai` converts Crest model context and tools to the Codex Responses protocol and converts streamed events back into Crest assistant events.
3. The desktop model catalog routes `openai-codex` refreshes to the account-scoped Codex model endpoint and continues routing every other provider to the existing Pi catalog source.
4. The renderer presents login state and model metadata through narrow IPC methods. It never receives access tokens, refresh tokens, or serialized credentials.

The request path is:

```text
Crest renderer
  -> agent IPC
  -> Crest agent harness
  -> dynamic ChatGPT auth resolver
  -> openai-codex-responses
  -> https://chatgpt.com/backend-api/codex/responses
```

## Authentication and Credential Storage

The existing OAuth PKCE implementation in `packages/ai/utils/oauth/openai-codex.ts` remains the protocol implementation. Electron main invokes it and opens the authorization URL in the system browser.

The callback server listens on the OpenAI-allowed localhost callback path. It tries port 1455 first and port 1457 when the preferred port is unavailable. It validates the OAuth state before exchanging the authorization code.

Credentials are stored as versioned JSON under the existing encrypted Crest secret named `OPENAI_CODEX_OAUTH`:

```json
{
  "version": 1,
  "access": "<access token>",
  "refresh": "<refresh token>",
  "expires": 1780000000000,
  "accountId": "<ChatGPT account id>",
  "email": "optional@example.com"
}
```

`~/.config/crest/ai.json` contains only the reference:

```json
{
  "providers": {
    "openai-codex": {
      "tokensecretname": "OPENAI_CODEX_OAUTH"
    }
  },
  "default": {
    "provider": "openai-codex",
    "model": "gpt-5.6-sol",
    "reasoning": "high"
  }
}
```

The main-process secret helper gains an atomic read-modify-write operation using Electron `safeStorage`. No OAuth credential is returned over IPC.

## Token Refresh

The service treats a token as expiring when fewer than five minutes remain. `getFreshCredentials()` returns the current credentials or joins a shared in-flight refresh promise. A successful refresh is persisted before callers receive the new access token.

Refresh failures are classified as follows:

- HTTP 400, 401, or 403 means the refresh credential is invalid or revoked. Crest clears the stored credential, publishes a signed-out state, and asks the user to sign in again.
- Network failures, timeouts, and HTTP 5xx responses are transient. Crest retains the credential and surfaces a retryable error.
- Signing out while refresh is running invalidates the refresh generation so late completion cannot restore signed-out credentials.

The agent runtime stores a dynamic resolver rather than a fixed access token. Each model request, tool-driven continuation, compaction request, and context summary resolves a fresh token through the same service.

## Model Discovery

After login and during catalog refresh, the service requests:

```text
GET https://chatgpt.com/backend-api/codex/models?client_version=0.0.0
```

The request uses the fresh bearer token, `chatgpt-account-id`, and `originator: crest`. Crest keeps models whose visibility is `list`, sorts them by server priority, and maps server metadata into the existing `Model<Api>` shape.

The checked-in fallback catalog contains GPT-5.6 Sol, Terra, and Luna using `openai-codex-responses`. It is used for first paint and when account discovery is temporarily unavailable. A successful account response is authoritative for picker visibility, so unavailable models are not offered after discovery completes.

The catalog source is composed by provider ID:

- `openai-codex` uses the account-scoped source.
- All other providers continue using `createPiModelCatalogSource` unchanged.

The model-catalog result and persisted provider cache gain an `authoritative` flag. Normal Pi catalog overlays continue merging with the checked-in baseline. A successful account-scoped `openai-codex` result sets `authoritative: true`, causing the visible catalog to replace the fallback baseline; this is how models absent from the account response disappear from the picker. Failed discovery does not replace the last successful account result.

## Codex Responses Provider

Crest restores a provider implementation compatible with its current in-tree Pi fork instead of copying a newer provider with unavailable dependencies.

For each request the provider:

- Sends to `https://chatgpt.com/backend-api/codex/responses`.
- Sets `Authorization`, `chatgpt-account-id`, `originator: crest`, and `OpenAI-Beta: responses=experimental`.
- Sends `store: false`.
- Uses the Crest session identifier for supported session/thread routing and prompt caching headers.
- Converts Crest text, image, reasoning, and tool messages to Responses input items.
- Converts streamed text, reasoning summaries, function calls, usage, completion, and error events to Crest's existing event stream.
- Leaves tool execution and approval decisions in the Crest harness.

The initial implementation uses SSE. WebSocket transport and request-body compression are intentionally deferred because they are not required to deliver a reliable first version and introduce dependencies absent from Crest's current Pi fork.

## Renderer and IPC

`ProviderEntry` gains an authentication kind so API-key and subscription providers render different cards. `openai-codex` uses the subscription kind.

The preload bridge exposes narrow methods:

- `getChatGptSubscriptionStatus()` returns signed-in state, optional email, model-catalog warning, and whether login is in progress.
- `loginChatGptSubscription()` starts browser login and returns only success or a sanitized error.
- `logoutChatGptSubscription()` removes the encrypted credential and provider configuration reference.
- `refreshChatGptSubscriptionModels()` forces account catalog refresh and returns model metadata.

The setup wizard and settings card both support the subscription provider. They show Sign in with ChatGPT, signed-in identity, Sign out, progress, and non-blocking catalog warnings. After successful login Crest adds the `openai-codex` provider reference to `ai.json`, refreshes the registry, and selects GPT-5.6 Sol when it is visible; otherwise it selects the first visible account model.

Signing out removes the encrypted credential but retains the `openai-codex` provider reference and current default selection. This preserves the existing `ai.json` invariant that at least one provider and default model exist, keeps the sign-in card discoverable, and avoids rewriting existing session selections. Existing sessions remain on disk and can be read, but attempting another turn with that provider produces an actionable sign-in error.

## Error Handling

- User cancellation returns the UI to signed-out state without overwriting an existing valid credential.
- OAuth state mismatch and malformed callback input terminate the login attempt and store nothing.
- Credential JSON parse failure is treated as signed out and reports that saved credentials are invalid.
- Model discovery timeout or transient failure retains the last successful account catalog, or the fallback catalog if none exists, and displays a warning.
- Subscription usage-limit errors are surfaced without automatic provider fallback.
- Authentication errors never include access tokens, refresh tokens, authorization codes, or raw response bodies that may contain credentials.
- A request made after sign-out fails before network dispatch.

## Testing

Implementation follows red-green-refactor cycles.

Unit tests cover:

- OAuth URL parameters, callback state validation, preferred/fallback ports, token exchange, and account ID extraction.
- Versioned credential serialization, encrypted secret update, corruption handling, and sign-out generation behavior.
- Refresh threshold, single-flight refresh, successful persistence, fatal clearing, and transient retention.
- Account model filtering, ordering, metadata mapping, and fallback behavior.
- Codex request URL, required headers, `store: false`, session routing, reasoning configuration, tool conversion, streamed tool calls, usage, and error mapping.
- Agent execution resolving fresh authentication per request rather than capturing a startup token.
- IPC returning sanitized state without credential fields.
- Setup wizard and settings card login, signed-in, warning, and sign-out states.

Integration verification covers:

1. Sign in through the browser and confirm account-visible models appear.
2. Select GPT-5.6 Sol and complete a prompt that invokes a Crest tool.
3. Restart Crest and continue using the saved subscription.
4. Force an expired access token and confirm one refresh request serves concurrent model operations.
5. Sign out and confirm sessions remain visible while a new turn requests sign-in.

## Rollout and Compatibility

The feature is additive. Existing API-key providers and configuration entries keep their current behavior. `openai-codex` is activated only after the user explicitly starts subscription setup or already has its provider reference in `ai.json`.

Because the direct ChatGPT Codex Responses endpoint is not the public OpenAI Platform API contract, the provider remains isolated behind its own transport and tests. Future Pi provider updates can be ported into that module without changing Crest's agent harness or UI contract.
