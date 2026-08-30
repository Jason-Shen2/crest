# ChatGPT Subscription Sol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `openai-codex` provider that signs in with a ChatGPT subscription, discovers the account's visible Codex models, and runs GPT-5.6 Sol through Crest's native agent harness.

**Architecture:** Electron main owns OAuth credentials, encrypted persistence, refresh, and account-scoped model discovery. `@crest/ai` owns an SSE-only `openai-codex-responses` transport, while the existing model catalog gains authoritative overlays and the agent harness resolves fresh credentials for every request. The renderer only receives sanitized auth status and model metadata through narrow IPC methods.

**Tech Stack:** TypeScript, Electron `safeStorage` and IPC, React, Vitest, OpenAI OAuth PKCE, Responses SSE protocol, Crest `@crest/ai` model catalog and agent harness.

---

## File map

- `packages/ai/model-catalog.ts`: persist and apply authoritative provider snapshots.
- `packages/ai/model-catalog.test.ts`: prove authoritative replacement and cache hydration.
- `packages/ai/utils/oauth/openai-codex.ts`: expose testable PKCE helpers, callback-port fallback, refresh error classification, and JWT account extraction.
- `packages/ai/utils/oauth/openai-codex.test.ts`: cover URL/state/ports/token/JWT behavior.
- `emain/aiconfig/secrets.ts`: add atomic encrypted secret writes and deletes.
- `emain/aiconfig/secrets.test.ts`: cover encryption, metadata preservation, corruption, and cache invalidation.
- `emain/aiconfig/chatgpt-subscription.ts`: own credential schema, login/logout/status, single-flight refresh, and generation safety.
- `emain/aiconfig/chatgpt-subscription.test.ts`: cover credential parsing and refresh lifecycle.
- `emain/aiconfig/chatgpt-model-catalog-source.ts`: fetch and map account-visible Codex models.
- `emain/aiconfig/chatgpt-model-catalog-source.test.ts`: cover headers, visibility, order, metadata, and failure behavior.
- `emain/model-catalog.ts`: route `openai-codex` to the account source and other providers to Pi.
- `emain/model-catalog.test.ts`: prove provider-source routing.
- `packages/ai/providers/openai-codex-responses.ts`: implement the Codex Responses SSE transport.
- `packages/ai/providers/openai-codex-responses.test.ts`: verify request construction and stream conversion.
- `packages/ai/providers/register-builtins.ts`: register `openai-codex-responses`.
- `packages/ai/models.generated.ts`: replace the stale Codex fallback with Sol, Terra, and Luna.
- `packages/ai/models.test.ts`: assert fallback model metadata and registration.
- `emain/agent-ipc.ts`: use the subscription service as a dynamic auth resolver.
- `emain/agent-ipc.test.ts`: prove token resolution occurs per model operation and fails after sign-out.
- `emain/aiconfig-ipc.ts`: expose sanitized subscription commands.
- `emain/aiconfig-ipc.test.ts`: verify IPC contracts and absence of credentials.
- `emain/preload.ts`: bridge the four subscription IPC methods.
- `frontend/types/custom.d.ts`: type the renderer-facing status and methods.
- `frontend/app/store/ai-catalog.ts`: add subscription auth kind and the `openai-codex` provider.
- `frontend/app/store/ai-catalog.test.ts`: verify provider projection and API type.
- `frontend/app/settings/components/ChatGptSubscriptionCard.tsx`: render login/status/warning/logout controls.
- `frontend/app/settings/components/ChatGptSubscriptionCard.test.tsx`: cover card states and actions.
- `frontend/app/settings/sections/ModelsSection.tsx`: select the subscription card by auth kind.
- `frontend/app/modals/ai-setup-wizard.tsx`: add ChatGPT sign-in setup and post-login default selection.
- `frontend/app/modals/ai-setup-wizard.test.tsx`: cover successful, cancelled, and warned login flows.

### Task 1: Authoritative model-catalog snapshots

**Files:**
- Modify: `packages/ai/model-catalog.ts`
- Test: `packages/ai/model-catalog.test.ts`

- [ ] **Step 1: Write failing authoritative snapshot tests**

Add tests that refresh and hydrate an `authoritative: true` snapshot and expect only the remote account models, while retaining the existing merge behavior for ordinary Pi overlays:

```ts
it("replaces the baseline with an authoritative provider snapshot", async () => {
    const source = new FakeSource();
    const catalog = createCatalog({ source });
    source.next("openai", updated([remoteModel], { lastModified: 2_000, authoritative: true }));

    await catalog.refreshProvider("openai", { force: true });

    expect(catalog.getModels("openai")).toEqual([remoteModel]);
});

it("hydrates an authoritative snapshot without restoring baseline-only models", async () => {
    const store = new MemoryStore();
    await store.writeProvider(
        "openai",
        providerState([remoteModel], { lastModified: 2_000, authoritative: true })
    );
    const catalog = createCatalog({ store, generatedAt: 1_000 });

    await catalog.hydrate();

    expect(catalog.getModels("openai")).toEqual([remoteModel]);
});
```

- [ ] **Step 2: Run the tests and verify red**

Run: `npx vitest run packages/ai/model-catalog.test.ts`

Expected: FAIL because `authoritative` is not accepted or the baseline model is still returned.

- [ ] **Step 3: Persist and apply the flag**

Extend both source results and provider cache, copy the value through `successfulState`, retain it on `not-modified`, and branch in `mergedModels`:

```ts
export interface ModelCatalogProviderCache {
    models: Model<Api>[];
    authoritative?: boolean;
    // existing fields remain unchanged
}

export type ModelCatalogSourceResult =
    | {
          kind: "updated";
          models: Model<Api>[];
          authoritative?: boolean;
          etag?: string;
          lastModified?: number;
      }
    | { kind: "not-modified"; authoritative?: boolean; etag?: string; lastModified?: number }
    | { kind: "unavailable" };

function mergedModels(providerId: string, state = providerStates.get(providerId)): Model<Api>[] {
    const providerBaseline = baseline.get(providerId) ?? [];
    if (!state || state.unavailable || !isOverlayNewer(state.lastModified, options.generatedAt)) {
        return providerBaseline;
    }
    return state.authoritative ? clone(state.models) : mergeModels(providerBaseline, state.models);
}
```

- [ ] **Step 4: Run the focused tests and commit**

Run: `npx vitest run packages/ai/model-catalog.test.ts emain/model-catalog-store.test.ts`

Expected: PASS.

Commit:

```bash
git add packages/ai/model-catalog.ts packages/ai/model-catalog.test.ts
git commit -m "feat: support authoritative model catalogs"
```

### Task 2: Atomic encrypted secret updates

**Files:**
- Modify: `emain/aiconfig/secrets.ts`
- Create: `emain/aiconfig/secrets.test.ts`

- [ ] **Step 1: Write failing secret mutation tests**

Mock `electron.safeStorage`, the config directory, and filesystem. Prove a write preserves unrelated entries and `wave:writets`, a delete removes only the requested secret, and malformed encrypted JSON rejects without overwriting the file:

```ts
it("atomically updates one encrypted secret while preserving other values", async () => {
    seedSecrets({ EXISTING: "keep", "wave:writets": 10 });

    await setSecret("OPENAI_CODEX_OAUTH", "credential-json");

    expect(readWrittenSecrets()).toMatchObject({
        EXISTING: "keep",
        OPENAI_CODEX_OAUTH: "credential-json",
    });
    expect(readWrittenSecrets()["wave:writets"]).toEqual(expect.any(Number));
});

it("removes only the selected encrypted secret", async () => {
    seedSecrets({ EXISTING: "keep", OPENAI_CODEX_OAUTH: "credential-json" });

    await deleteSecret("OPENAI_CODEX_OAUTH");

    expect(readWrittenSecrets()).toMatchObject({ EXISTING: "keep" });
    expect(readWrittenSecrets()).not.toHaveProperty("OPENAI_CODEX_OAUTH");
});
```

- [ ] **Step 2: Run the tests and verify red**

Run: `npx vitest run emain/aiconfig/secrets.test.ts`

Expected: FAIL because `setSecret` and `deleteSecret` are not exported.

- [ ] **Step 3: Add one serialized read-modify-write path**

Use a module-level promise to serialize writers, encrypt UTF-8 JSON with `safeStorage.encryptString`, write a sibling temporary file, rename it over `secrets.enc`, and invalidate the read cache:

```ts
let pendingMutation: Promise<void> = Promise.resolve();

export function setSecret(name: string, value: string): Promise<void> {
    return mutateSecrets((secrets) => {
        secrets[name] = value;
    });
}

export function deleteSecret(name: string): Promise<void> {
    return mutateSecrets((secrets) => {
        delete secrets[name];
    });
}

function mutateSecrets(change: (secrets: Record<string, string | number>) => void): Promise<void> {
    const mutation = pendingMutation.then(async () => {
        const secrets = await loadMutableSecrets();
        change(secrets);
        secrets[WRITE_TS_KEY] = Date.now();
        await writeEncryptedSecretsAtomically(secrets);
        cache = null;
    });
    pendingMutation = mutation.catch(() => undefined);
    return mutation;
}
```

- [ ] **Step 4: Run the focused tests and commit**

Run: `npx vitest run emain/aiconfig/secrets.test.ts emain/aiconfig/user-config.test.ts`

Expected: PASS.

Commit:

```bash
git add emain/aiconfig/secrets.ts emain/aiconfig/secrets.test.ts
git commit -m "feat: add encrypted secret mutations"
```

### Task 3: Testable OpenAI Codex OAuth protocol

**Files:**
- Modify: `packages/ai/utils/oauth/openai-codex.ts`
- Create: `packages/ai/utils/oauth/openai-codex.test.ts`

- [ ] **Step 1: Write failing OAuth protocol tests**

Cover the required authorization parameters, strict state validation, preferred port 1455 with 1457 fallback, sanitized token failure, refresh status preservation, and ChatGPT account extraction:

```ts
it("creates a Crest OAuth URL with PKCE and the selected callback port", async () => {
    const flow = await createAuthorizationFlow("crest", 1457);
    const url = new URL(flow.url);

    expect(url.searchParams.get("originator")).toBe("crest");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1457/auth/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(flow.state).not.toBe("");
});

it("extracts the ChatGPT account id from the access token", () => {
    const access = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } });
    expect(extractChatGptAccountId(access)).toBe("account-1");
});

it("tries port 1457 when port 1455 is already in use", async () => {
    const server = await startLocalOAuthServer("expected-state", { listen: fakeListen(["EADDRINUSE", 1457]) });
    expect(server.redirectUri).toBe("http://localhost:1457/auth/callback");
    server.close();
});
```

- [ ] **Step 2: Run the tests and verify red**

Run: `npx vitest run packages/ai/utils/oauth/openai-codex.test.ts`

Expected: FAIL because the helpers and port-aware callback URI are not exposed.

- [ ] **Step 3: Make the OAuth implementation injectable and port-aware**

Export the narrow protocol helpers, calculate redirect URI from the successfully bound port, keep the state check inside the callback handler, and preserve HTTP status in refresh failures:

```ts
export const OPENAI_CODEX_CALLBACK_PORTS = [1455, 1457] as const;

export function callbackUri(port: number): string {
    return `http://localhost:${port}/auth/callback`;
}

export function extractChatGptAccountId(token: string): string | undefined {
    const payload = decodeJwt(token);
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
}

export async function createAuthorizationFlow(
    originator = "crest",
    port = OPENAI_CODEX_CALLBACK_PORTS[0]
): Promise<{ verifier: string; state: string; url: string; redirectUri: string }> {
    const redirectUri = callbackUri(port);
    // construct the existing PKCE URL with redirectUri and originator
    return { verifier, state, url: url.toString(), redirectUri };
}
```

- [ ] **Step 4: Run OAuth tests and commit**

Run: `npx vitest run packages/ai/utils/oauth/openai-codex.test.ts`

Expected: PASS.

Commit:

```bash
git add packages/ai/utils/oauth/openai-codex.ts packages/ai/utils/oauth/openai-codex.test.ts
git commit -m "feat: harden ChatGPT OAuth flow"
```

### Task 4: ChatGPT subscription lifecycle service

**Files:**
- Create: `emain/aiconfig/chatgpt-subscription.ts`
- Create: `emain/aiconfig/chatgpt-subscription.test.ts`

- [ ] **Step 1: Write failing credential and refresh tests**

Construct the service with injected OAuth, clock, secret store, and browser opener. Test corrupted storage, a five-minute refresh threshold, concurrent refresh joining, persistence before return, transient retention, fatal clearing, and logout invalidating a late refresh:

```ts
it("coalesces concurrent refreshes and persists before returning", async () => {
    const refresh = deferred<OAuthTokenResult>();
    const dependencies = createDependencies({ refreshAccessToken: vi.fn(() => refresh.promise) });
    dependencies.seed(expiringCredential());
    const service = createChatGptSubscriptionService(dependencies);

    const first = service.getFreshCredentials();
    const second = service.getFreshCredentials();
    refresh.resolve(successToken("new-access", "new-refresh"));

    await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ access: "new-access" }),
        expect.objectContaining({ access: "new-access" }),
    ]);
    expect(dependencies.refreshAccessToken).toHaveBeenCalledOnce();
    expect(dependencies.setSecret).toHaveBeenCalledBefore(dependencies.onCredentialAvailable);
});

it("does not restore credentials when logout wins a refresh race", async () => {
    const refresh = deferred<OAuthTokenResult>();
    const dependencies = createDependencies({ refreshAccessToken: () => refresh.promise });
    dependencies.seed(expiringCredential());
    const service = createChatGptSubscriptionService(dependencies);

    const pending = service.getFreshCredentials();
    await service.logout();
    refresh.resolve(successToken("late-access", "late-refresh"));

    await expect(pending).rejects.toThrow("signed out");
    await expect(service.getStatus()).resolves.toMatchObject({ signedIn: false });
});
```

- [ ] **Step 2: Run the tests and verify red**

Run: `npx vitest run emain/aiconfig/chatgpt-subscription.test.ts`

Expected: FAIL because the service module does not exist.

- [ ] **Step 3: Implement the versioned service boundary**

Implement these public types and methods, keeping all credential-bearing values private to Electron main:

```ts
export const OPENAI_CODEX_OAUTH_SECRET = "OPENAI_CODEX_OAUTH";

export interface ChatGptCredential {
    version: 1;
    access: string;
    refresh: string;
    expires: number;
    accountId: string;
    email?: string;
}

export interface ChatGptSubscriptionStatus {
    signedIn: boolean;
    email?: string;
    loginInProgress: boolean;
    modelCatalogWarning?: string;
}

export interface ChatGptSubscriptionService {
    getStatus(): Promise<ChatGptSubscriptionStatus>;
    login(): Promise<ChatGptSubscriptionStatus>;
    logout(): Promise<void>;
    getFreshCredentials(): Promise<ChatGptCredential>;
    setModelCatalogWarning(warning?: string): void;
}
```

Use `expires - now() >= 5 * 60_000` as fresh. Clear stored credentials for refresh status 400, 401, or 403; retain them for transport errors and 5xx. Compare a captured generation after refresh before persisting.

- [ ] **Step 4: Run service tests and commit**

Run: `npx vitest run emain/aiconfig/chatgpt-subscription.test.ts emain/aiconfig/secrets.test.ts`

Expected: PASS.

Commit:

```bash
git add emain/aiconfig/chatgpt-subscription.ts emain/aiconfig/chatgpt-subscription.test.ts
git commit -m "feat: manage ChatGPT subscription credentials"
```

### Task 5: Account-scoped Codex model discovery

**Files:**
- Create: `emain/aiconfig/chatgpt-model-catalog-source.ts`
- Create: `emain/aiconfig/chatgpt-model-catalog-source.test.ts`
- Modify: `emain/model-catalog.ts`
- Test: `emain/model-catalog.test.ts`

- [ ] **Step 1: Write failing source and routing tests**

Test the exact endpoint and headers, `visibility === "list"` filtering, priority ordering, metadata mapping, authoritative output, abort propagation, and provider routing:

```ts
it("returns an authoritative account-visible model snapshot", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ models: [hiddenModel, lunaModel, solModel] }));
    const source = createChatGptModelCatalogSource({ subscription, fetch: fetchMock });

    const result = await source.fetchProvider({
        providerId: "openai-codex",
        signal: new AbortController().signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
        "https://chatgpt.com/backend-api/codex/models?client_version=0.0.0",
        expect.objectContaining({
            headers: expect.objectContaining({
                Authorization: "Bearer access-token",
                "chatgpt-account-id": "account-1",
                originator: "crest",
            }),
        })
    );
    expect(result).toMatchObject({
        kind: "updated",
        authoritative: true,
        models: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.6-luna" }],
    });
});

it("routes only openai-codex through the account source", async () => {
    const source = createDesktopModelCatalogSource(piSource, codexSource);
    await source.fetchProvider(request("openai-codex"));
    await source.fetchProvider(request("anthropic"));
    expect(codexSource.fetchProvider).toHaveBeenCalledOnce();
    expect(piSource.fetchProvider).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the tests and verify red**

Run: `npx vitest run emain/aiconfig/chatgpt-model-catalog-source.test.ts emain/model-catalog.test.ts`

Expected: FAIL because the account source and provider router do not exist.

- [ ] **Step 3: Implement mapping and source composition**

Expose a small router and map each account model into Crest's existing shape:

```ts
export function createDesktopModelCatalogSource(
    piSource: ModelCatalogSource,
    codexSource: ModelCatalogSource
): ModelCatalogSource {
    return {
        fetchProvider(input) {
            return input.providerId === "openai-codex"
                ? codexSource.fetchProvider(input)
                : piSource.fetchProvider(input);
        },
    };
}
```

The Codex source returns `{ kind: "unavailable" }` when signed out, throws sanitized errors on non-2xx responses, and returns `{ kind: "updated", authoritative: true, models }` on success. Use server-provided context and output limits when numeric and the checked-in fallback limits otherwise.

- [ ] **Step 4: Run source tests and commit**

Run: `npx vitest run emain/aiconfig/chatgpt-model-catalog-source.test.ts emain/model-catalog.test.ts packages/ai/model-catalog.test.ts`

Expected: PASS.

Commit:

```bash
git add emain/aiconfig/chatgpt-model-catalog-source.ts emain/aiconfig/chatgpt-model-catalog-source.test.ts emain/model-catalog.ts emain/model-catalog.test.ts
git commit -m "feat: discover ChatGPT account models"
```

### Task 6: SSE-only Codex Responses transport

**Files:**
- Create: `packages/ai/providers/openai-codex-responses.ts`
- Create: `packages/ai/providers/openai-codex-responses.test.ts`
- Modify: `packages/ai/providers/register-builtins.ts`

- [ ] **Step 1: Write failing transport tests**

Use a fake fetch that returns a deterministic SSE stream. Assert request URL, headers, `store: false`, reasoning level, session routing, tool schema conversion, text deltas, reasoning summary deltas, tool-call completion, usage, and sanitized errors:

```ts
it("streams a Codex response through the Crest event contract", async () => {
    fetchMock.mockResolvedValue(
        sseResponse([
            event("response.output_text.delta", { delta: "hello" }),
            event("response.output_item.done", functionCall("call-1", "read_file", '{"path":"a.ts"}')),
            event("response.completed", completedResponse({ input_tokens: 11, output_tokens: 7 })),
        ])
    );

    const events = await collect(
        streamOpenAICodexResponses(model, contextWithTool, {
            apiKey: "access-token",
            sessionId: "crest-session",
            reasoning: "high",
        })
    );

    expect(fetchMock).toHaveBeenCalledWith(
        "https://chatgpt.com/backend-api/codex/responses",
        expect.objectContaining({
            headers: expect.objectContaining({
                Authorization: "Bearer access-token",
                "chatgpt-account-id": "account-1",
                originator: "crest",
                "OpenAI-Beta": "responses=experimental",
            }),
        })
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        store: false,
        model: "gpt-5.6-sol",
        reasoning: { effort: "high" },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "text_delta", delta: "hello" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "done" }));
});
```

- [ ] **Step 2: Run the tests and verify red**

Run: `npx vitest run packages/ai/providers/openai-codex-responses.test.ts`

Expected: FAIL because the provider implementation is absent and the API type is unregistered.

- [ ] **Step 3: Port the compatible Responses path without WebSocket code**

Implement `streamOpenAICodexResponses` using the existing `convertResponsesMessages`, `convertResponsesTools`, `processResponsesStream`, `AssistantMessageEventStream`, and simple-stream option helpers. Resolve the account ID from the bearer JWT before dispatch; throw `Sign in with ChatGPT again` when it is missing. Register the API in `register-builtins.ts`:

```ts
registerApiProvider({
    api: "openai-codex-responses",
    stream: streamOpenAICodexResponses,
    streamSimple: streamSimpleOpenAICodexResponses,
});
```

The implementation must call `${model.baseUrl}/codex/responses`, set `Accept: text/event-stream`, pass the caller's abort signal, set `store: false`, and omit WebSocket and compression branches.

- [ ] **Step 4: Run transport and regression tests, then commit**

Run: `npx vitest run packages/ai/providers/openai-codex-responses.test.ts packages/ai/providers/openai-responses.test.ts packages/ai/providers/context-count-schema.test.ts`

Expected: PASS.

Commit:

```bash
git add packages/ai/providers/openai-codex-responses.ts packages/ai/providers/openai-codex-responses.test.ts packages/ai/providers/register-builtins.ts
git commit -m "feat: restore Codex Responses transport"
```

### Task 7: GPT-5.6 Sol, Terra, and Luna fallback catalog

**Files:**
- Modify: `packages/ai/models.generated.ts`
- Test: `packages/ai/models.test.ts`

- [ ] **Step 1: Write failing fallback catalog assertions**

```ts
it("ships a minimal GPT-5.6 Codex fallback catalog", () => {
    expect(getModels("openai-codex").map((model) => model.id)).toEqual([
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
    ]);
    expect(getModel("openai-codex", "gpt-5.6-sol")).toMatchObject({
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: true,
        input: ["text", "image"],
    });
});
```

- [ ] **Step 2: Run the test and verify red**

Run: `npx vitest run packages/ai/models.test.ts`

Expected: FAIL because the generated catalog still contains older Codex models.

- [ ] **Step 3: Replace only the `openai-codex` generated block**

Create Sol, Terra, and Luna entries with `api: "openai-codex-responses"`, base URL `https://chatgpt.com/backend-api`, zero API-price accounting, text/image input, reasoning enabled, a 372,000-token fallback context window, a 128,000-token output limit, and low/medium/high/xhigh/max thinking-level support.

- [ ] **Step 4: Run model tests and commit**

Run: `npx vitest run packages/ai/models.test.ts packages/ai/providers/openai-codex-responses.test.ts`

Expected: PASS.

Commit:

```bash
git add packages/ai/models.generated.ts packages/ai/models.test.ts
git commit -m "feat: add GPT-5.6 Codex fallback models"
```

### Task 8: Resolve subscription credentials for every agent operation

**Files:**
- Modify: `emain/agent-ipc.ts`
- Test: `emain/agent-ipc.test.ts`

- [ ] **Step 1: Write failing dynamic-auth tests**

Inject a `ChatGptSubscriptionService`, resolve an `openai-codex` execution, invoke its auth resolver twice, and prove the service is called twice rather than capturing the first token. Also cover sign-out before a continuation and context-summary authentication:

```ts
it("resolves fresh ChatGPT credentials for every model operation", async () => {
    subscription.getFreshCredentials
        .mockResolvedValueOnce(credential("access-1"))
        .mockResolvedValueOnce(credential("access-2"));
    const execution = await resolveAgentExecution(codexOptions(), catalog, { subscription });

    await expect(execution.config.authResolver?.()).resolves.toEqual({ apiKey: "access-1" });
    await expect(execution.config.authResolver?.()).resolves.toEqual({ apiKey: "access-2" });
    expect(subscription.getFreshCredentials).toHaveBeenCalledTimes(2);
});

it("rejects a continuation after ChatGPT sign-out", async () => {
    subscription.getFreshCredentials.mockRejectedValue(new Error("Sign in with ChatGPT to continue"));
    const execution = await resolveAgentExecution(codexOptions(), catalog, { subscription });
    await expect(execution.config.authResolver?.()).rejects.toThrow("Sign in with ChatGPT");
});
```

- [ ] **Step 2: Run the tests and verify red**

Run: `npx vitest run emain/agent-ipc.test.ts`

Expected: FAIL because `resolveAgentExecution` still resolves a static secret once.

- [ ] **Step 3: Route only `openai-codex` through dynamic auth**

Select the resolver from provider ID:

```ts
const authResolver =
    opts.provider === "openai-codex"
        ? async () => ({ apiKey: (await chatGptSubscription.getFreshCredentials()).access })
        : async () => ({ apiKey: await resolveApiKey(opts) });
```

Pass the same resolver into the initial harness configuration, tool-driven continuations, compaction, and summary model call sites. Preserve current static behavior for every other provider.

- [ ] **Step 4: Run agent tests and commit**

Run: `npx vitest run emain/agent-ipc.test.ts packages/agent`

Expected: PASS.

Commit:

```bash
git add emain/agent-ipc.ts emain/agent-ipc.test.ts
git commit -m "feat: refresh ChatGPT auth during agent runs"
```

### Task 9: Subscription IPC and preload bridge

**Files:**
- Modify: `emain/aiconfig-ipc.ts`
- Test: `emain/aiconfig-ipc.test.ts`
- Modify: `emain/preload.ts`
- Modify: `frontend/types/custom.d.ts`

- [ ] **Step 1: Write failing IPC privacy tests**

```ts
it("registers sanitized ChatGPT subscription IPC handlers", async () => {
    registerAiConfigIpcHandlers(catalog, subscription);

    const status = await invokeHandler("ai:get-chatgpt-subscription-status");
    expect(status).toEqual({ signedIn: true, email: "user@example.com", loginInProgress: false });
    expect(JSON.stringify(status)).not.toContain("access-token");
    expect(JSON.stringify(status)).not.toContain("refresh-token");

    await invokeHandler("ai:logout-chatgpt-subscription");
    expect(subscription.logout).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the tests and verify red**

Run: `npx vitest run emain/aiconfig-ipc.test.ts`

Expected: FAIL because no subscription handlers are registered.

- [ ] **Step 3: Add four narrow commands and matching renderer types**

Register status, login, logout, and forced model refresh. Login updates `ai.json` with `tokensecretname: "OPENAI_CODEX_OAUTH"`, activates and refreshes the catalog, and chooses Sol when visible. The preload surface is:

```ts
ai: {
    getChatGptSubscriptionStatus: () => ipcRenderer.invoke("ai:get-chatgpt-subscription-status"),
    loginChatGptSubscription: () => ipcRenderer.invoke("ai:login-chatgpt-subscription"),
    logoutChatGptSubscription: () => ipcRenderer.invoke("ai:logout-chatgpt-subscription"),
    refreshChatGptSubscriptionModels: () =>
        ipcRenderer.invoke("ai:refresh-chatgpt-subscription-models"),
}
```

Mirror `ChatGptSubscriptionStatus` and return `RegistryModelInfo[]` for refresh in `frontend/types/custom.d.ts`. Do not add any credential field.

- [ ] **Step 4: Run IPC tests and commit**

Run: `npx vitest run emain/aiconfig-ipc.test.ts emain/aiconfig/user-config.test.ts`

Expected: PASS.

Commit:

```bash
git add emain/aiconfig-ipc.ts emain/aiconfig-ipc.test.ts emain/preload.ts frontend/types/custom.d.ts
git commit -m "feat: expose ChatGPT subscription controls"
```

### Task 10: Subscription provider in the renderer catalog and settings

**Files:**
- Modify: `frontend/app/store/ai-catalog.ts`
- Test: `frontend/app/store/ai-catalog.test.ts`
- Modify: `frontend/app/settings/components/ProviderIcon.tsx`
- Create: `frontend/app/settings/components/ChatGptSubscriptionCard.tsx`
- Create: `frontend/app/settings/components/ChatGptSubscriptionCard.test.tsx`
- Modify: `frontend/app/settings/sections/ModelsSection.tsx`

- [ ] **Step 1: Write failing catalog and component tests**

```ts
it("describes OpenAI Codex as a subscription provider", () => {
    expect(findProvider("openai-codex")).toMatchObject({
        authKind: "chatgpt-subscription",
        apiType: "openai-codex-responses",
        defaultModel: "gpt-5.6-sol",
    });
});
```

```tsx
it("shows identity and signs out without rendering credentials", async () => {
    window.api.ai.getChatGptSubscriptionStatus.mockResolvedValue({
        signedIn: true,
        email: "user@example.com",
        loginInProgress: false,
    });
    render(<ChatGptSubscriptionCard provider={codexProvider} onChanged={onChanged} />);
    expect(await screen.findByText("user@example.com")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(window.api.ai.logoutChatGptSubscription).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run the tests and verify red**

Run: `npx vitest run frontend/app/store/ai-catalog.test.ts frontend/app/settings/components/ChatGptSubscriptionCard.test.tsx`

Expected: FAIL because the auth kind, provider entry, and card do not exist.

- [ ] **Step 3: Add catalog metadata and the stateful card**

Extend the unions:

```ts
export type ApiType =
    | "openai-responses"
    | "openai-chat"
    | "openai-codex-responses"
    | "google-gemini"
    | "anthropic-messages";

export type ProviderAuthKind = "api-key" | "chatgpt-subscription";

export interface ProviderEntry {
    authKind?: ProviderAuthKind;
    // existing fields remain unchanged
}
```

Add `openai-codex` with `authKind: "chatgpt-subscription"`. The card loads status on mount, disables duplicate actions, renders model-catalog warnings non-blockingly, calls login/logout, and invokes `onChanged` after successful state changes. `ModelsSection` renders this card when `provider.authKind === "chatgpt-subscription"`; all current providers keep `ProviderKeyCard`.

- [ ] **Step 4: Run renderer tests and commit**

Run: `npx vitest run frontend/app/store/ai-catalog.test.ts frontend/app/settings/components/ChatGptSubscriptionCard.test.tsx`

Expected: PASS.

Commit:

```bash
git add frontend/app/store/ai-catalog.ts frontend/app/store/ai-catalog.test.ts frontend/app/settings/components/ProviderIcon.tsx frontend/app/settings/components/ChatGptSubscriptionCard.tsx frontend/app/settings/components/ChatGptSubscriptionCard.test.tsx frontend/app/settings/sections/ModelsSection.tsx
git commit -m "feat: add ChatGPT subscription settings"
```

### Task 11: ChatGPT subscription setup wizard

**Files:**
- Modify: `frontend/app/modals/ai-setup-wizard.tsx`
- Create: `frontend/app/modals/ai-setup-wizard.test.tsx`

- [ ] **Step 1: Write failing setup-flow tests**

```tsx
it("signs in and selects Sol when the account exposes it", async () => {
    window.api.ai.loginChatGptSubscription.mockResolvedValue({
        signedIn: true,
        email: "user@example.com",
        loginInProgress: false,
    });
    window.api.ai.refreshChatGptSubscriptionModels.mockResolvedValue([
        { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
    ]);
    render(<AISetupWizard onClose={onClose} />);

    await userEvent.click(screen.getByText("ChatGPT subscription"));
    await userEvent.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));

    expect(window.api.ai.writeUserConfig).toHaveBeenCalledWith(
        expect.objectContaining({
            providers: expect.objectContaining({
                "openai-codex": { tokensecretname: "OPENAI_CODEX_OAUTH" },
            }),
            default: { provider: "openai-codex", model: "gpt-5.6-sol", reasoning: "high" },
        })
    );
});
```

Also test cancellation leaves existing configuration untouched and a catalog warning still permits completion with the first returned model.

- [ ] **Step 2: Run the test and verify red**

Run: `npx vitest run frontend/app/modals/ai-setup-wizard.test.tsx`

Expected: FAIL because the wizard only supports API-key providers.

- [ ] **Step 3: Add the subscription branch**

Render `Sign in with ChatGPT` for `chatgpt-subscription`, delegate credential creation to main through IPC, refresh account models after login, select `gpt-5.6-sol` when present or the first visible model otherwise, and keep the current API-key flow unchanged. Treat a returned signed-out status as cancellation rather than an error.

- [ ] **Step 4: Run setup and settings tests, then commit**

Run: `npx vitest run frontend/app/modals/ai-setup-wizard.test.tsx frontend/app/settings/components/ChatGptSubscriptionCard.test.tsx frontend/app/store/ai-catalog.test.ts`

Expected: PASS.

Commit:

```bash
git add frontend/app/modals/ai-setup-wizard.tsx frontend/app/modals/ai-setup-wizard.test.tsx
git commit -m "feat: add ChatGPT subscription setup"
```

### Task 12: Cross-layer verification and documentation

**Files:**
- Modify: `docs/superpowers/specs/2026-08-26-chatgpt-subscription-sol-design.md` only if implementation-driven contract details changed
- Modify: `docs/superpowers/plans/2026-08-26-chatgpt-subscription-sol.md` to mark completed checkboxes

- [ ] **Step 1: Run all focused suites together**

Run:

```bash
npx vitest run \
  packages/ai/model-catalog.test.ts \
  packages/ai/utils/oauth/openai-codex.test.ts \
  packages/ai/providers/openai-codex-responses.test.ts \
  packages/ai/models.test.ts \
  emain/aiconfig/secrets.test.ts \
  emain/aiconfig/chatgpt-subscription.test.ts \
  emain/aiconfig/chatgpt-model-catalog-source.test.ts \
  emain/model-catalog.test.ts \
  emain/agent-ipc.test.ts \
  emain/aiconfig-ipc.test.ts \
  frontend/app/store/ai-catalog.test.ts \
  frontend/app/settings/components/ChatGptSubscriptionCard.test.tsx \
  frontend/app/modals/ai-setup-wizard.test.tsx
```

Expected: all focused suites PASS with no unhandled rejection.

- [ ] **Step 2: Run static and build verification**

Run:

```bash
npm run build:dev
git diff --check
```

Expected: the Electron development build, including TypeScript compilation, succeeds and `git diff --check` prints nothing.

- [ ] **Step 3: Perform the manual desktop acceptance flow**

Launch Crest in development mode and verify, in order:

1. Settings and first-run setup both open the system browser and complete ChatGPT sign-in.
2. The model picker shows only account-visible models after refresh and includes GPT-5.6 Sol when the account is entitled.
3. A Sol prompt can invoke a Crest tool and complete the tool continuation.
4. Restarting Crest keeps the account signed in and the model usable.
5. Signing out preserves existing sessions; attempting another turn shows an actionable sign-in error.

- [ ] **Step 4: Review security invariants**

Run:

```bash
rg -n "access_token|refresh_token|OPENAI_CODEX_OAUTH" frontend emain/preload.ts frontend/types/custom.d.ts
rg -n "console\.(log|error).*token|JSON\.stringify\(.*credential" emain packages/ai
```

Expected: renderer/preload contracts contain only the secret name and sanitized status, and no log statement serializes tokens or credential objects.

- [ ] **Step 5: Commit final verification updates**

```bash
git add -f docs/superpowers/specs/2026-08-26-chatgpt-subscription-sol-design.md docs/superpowers/plans/2026-08-26-chatgpt-subscription-sol.md
git commit -m "docs: record ChatGPT subscription verification"
```
