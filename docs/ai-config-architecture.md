# AI Config and Desktop Model Catalog Architecture

**Status:** implemented · **Updated:** 2026-08-03

Crest Agent is a desktop Electron application. Its model catalog, model execution, credentials, and provider availability checks are owned by the desktop process; there is no separate Crest CLI runtime in this architecture.

## Ownership

```text
packages/ai/models.generated.ts (offline snapshot)
                    +
pi.dev provider catalog (fresh model facts)
                    |
                    v
Electron ModelCatalogService + model-catalog.json
            |                         |
            v                         v
registry model IPC                agent-ipc
            |                         |
            v                         v
renderer projection             AgentHarness execution

provider /models -> account or deployment availability only
```

The unified catalog answers: “What is this model?” It owns model IDs, display names, provider/API routing data, input modalities, context limits, output limits, cost, reasoning support, and thinking levels.

A provider's `/models` endpoint answers only: “Can this account or deployment currently see this ID?” Its result is credential-scoped and ephemeral. It never updates the global catalog or replaces catalog capabilities.

## Electron model catalog

The process-wide catalog is created in `emain/model-catalog.ts` from:

- the checked-in `packages/ai/models.generated.ts` snapshot;
- provider-specific refreshes from `https://pi.dev/api/models/providers/<provider>`;
- the last valid disk cache in the Wave data directory at `model-catalog.json`.

The generated snapshot keeps startup and offline operation deterministic. Remote records replace matching snapshot IDs and append new IDs after the full provider response validates. Invalid or older responses do not partially alter a provider.

### Refresh lifecycle

- Hydrate the disk cache before registering model-dependent IPC handlers.
- Mark providers present in `ai.json` active during startup.
- Start the window without waiting for a network refresh.
- Treat a successful provider result as fresh for five minutes.
- Refresh active providers every 60 minutes.
- Use a 10-second source timeout and retry transient failures twice.
- Honor ETag/304 responses and reject a remote `Last-Modified` older than a timestamped snapshot.
- Apply exponential retry suppression after failures.
- Coalesce concurrent requests in-process.
- Use provider refresh locks and a separate write lock across processes.
- Write a temporary file, fsync it, then atomically rename it.
- Preserve the snapshot and last good cache when the network fails.
- Abort in-flight catalog requests during accepted app shutdown.

The shared service publishes revisions only when the effective merged model set changes.

## Desktop consumers

### Agent execution

`emain/agent-ipc.ts` resolves `{ provider, model, reasoning? }` through the shared `ModelCatalog` before creating or updating an `AgentHarness` execution config.

For a cached model, execution can proceed immediately while a normal refresh runs in the background. For a missing model, Electron awaits one refresh and retries the lookup. Unknown IDs fail explicitly. A live session observes updated model objects through its existing execution-config synchronization; the session runtime does not need replacement.

The renderer never supplies trusted endpoint or capability metadata to the Agent runtime. It sends the selection and credential reference; Electron independently resolves the model from the same catalog used by registry IPC.

### Registry IPC

The preload API exposes:

- `ai.listRegistryModels(provider)` for a TTL-aware read/refresh;
- `ai.refreshRegistryModels(provider)` for a forced refresh;
- `ai.listProviderModels(input)` for provider availability discovery.

The first two project the shared Electron catalog into renderer-friendly metadata. The third calls the configured provider or custom endpoint using the selected account credentials and does not mutate the catalog.

## Renderer projection

`frontend/app/store/ai-registry-models.ts` keeps per-provider catalog state. Requests are coalesced and cached for the renderer session; a failed manual refresh preserves the last successful models.

`frontend/app/store/ai-provider-models.ts` separately stores account/deployment availability. Its errors and loading state cannot erase catalog facts.

`projectRegistryCatalog()` combines Electron model facts with provider presentation and endpoint configuration from `frontend/app/store/ai-catalog.ts`:

- Electron facts win for names, modalities, context limits, and reasoning controls.
- Renderer-only facts that Electron cannot express remain available.
- Unsupported Electron thinking levels are omitted from the renderer's `low | medium | high` union.
- The checked-in renderer arrays are first-paint and older-preload compatibility fallback only.
- `custom_models` and `custom_endpoints` remain explicit user overlays.

The picker combines projected facts and availability as follows:

- Present in both: show the catalog metadata.
- Present only in the catalog: hide it when a non-empty `/models` result is acting as the account visibility filter; otherwise retain the catalog fallback.
- Present only in `/models`: show a provisional ID/name with unknown catalog capabilities and limits.
- No usable `/models` endpoint: show catalog entries without an availability filter.

Provider-only deployment aliases are never written to `registryModelsMapAtom` or the disk catalog.

## User configuration

`~/.config/crest/ai.json` contains user intent rather than public model facts:

```jsonc
{
  "providers": {
    "openai": { "tokensecretname": "OPENAI_API_KEY" },
  },
  "default": {
    "provider": "openai",
    "model": "gpt-5",
    "reasoning": "medium",
  },
  "profiles": {
    "fast": { "provider": "openai", "model": "gpt-5-mini" },
  },
  "custom_models": [],
  "custom_endpoints": {},
  "pinned": [],
}
```

Provider entries identify credentials. Literal tokens are supported for testing, but OS-keychain secret names are preferred. A literal token wins when both are present. Custom endpoints own their endpoint/API type and may enumerate explicitly configured models.

The current selection is an inline `{ provider, model, reasoning? }` value in Workspace Agent state. It falls back to `ai.json.default` and survives profile changes because it is not a profile reference.

## Failure behavior

| Failure                                 | Result                                           |
| --------------------------------------- | ------------------------------------------------ |
| pi.dev unavailable                      | Use the generated snapshot and last valid cache. |
| Corrupt cache                           | Ignore it and use the generated snapshot.        |
| Provider `/models` authentication fails | Keep catalog facts; show the availability error. |
| Forced renderer refresh fails           | Keep the last successful renderer models.        |
| Selected model absent from cache        | Await one catalog refresh, then retry.           |
| Selected model still unknown            | Return an explicit unknown-model error.          |

## Primary files

- `packages/ai/model-catalog.ts` — shared merge, TTL, retry, refresh, and subscription logic.
- `packages/ai/pi-model-catalog-source.ts` — pi.dev HTTP source and validation.
- `packages/ai/models.generated.ts` — offline and request-building baseline.
- `emain/model-catalog-store.ts` — locked atomic persistence.
- `emain/model-catalog.ts` — desktop singleton lifecycle.
- `emain/aiconfig-ipc.ts` — registry and provider-availability IPC.
- `emain/agent-ipc.ts` — authoritative execution lookup.
- `frontend/app/store/ai-registry-models.ts` — renderer catalog state.
- `frontend/app/store/ai-provider-models.ts` — account/deployment availability state.
- `frontend/app/store/ai-catalog.ts` — provider presentation plus first-paint fallback and projection.
- `frontend/app/store/ai-resolver.ts` — renderer validation/display resolution against a supplied projected catalog.
- `frontend/app/view/cmdblock/model-picker-popover.tsx` — combined catalog and availability UI.
