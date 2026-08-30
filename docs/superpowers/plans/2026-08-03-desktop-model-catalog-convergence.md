# Crest Desktop Model Catalog Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Crest desktop one Electron-owned, refreshable model catalog that drives both the renderer model experience and the `agent-ipc -> AgentHarness` request path, while keeping provider `/models` limited to account/deployment availability.

**Architecture:** Add an environment-neutral `ModelCatalogService` beside the desktop `@crest/ai` registry, backed by the checked-in `packages/ai/models.generated.ts` snapshot plus validated per-provider `pi.dev` overlays. Electron supplies the locked atomic file store and owns hydration, scheduling, IPC, and shutdown. Renderer code projects Electron registry data onto its provider presentation catalog; Agent IPC independently resolves every selected model through the same service. The inherited pi CLI `ModelRuntime` and `packages/coding-agent/src/core/remote-catalog-provider.ts` remain untouched.

**Tech Stack:** TypeScript, Electron IPC, Node.js `fs/promises`, native `fetch`, Jotai, React 19, Vitest

**Dirty-worktree rule:** This workspace already contains unrelated user edits in several target files. Before every commit, inspect both `git diff -- <paths>` and `git diff --cached`. Stage only task-owned hunks (for overlapping files use `git add -p` or an equivalent exact cached patch). If a task-owned hunk cannot be isolated safely, leave it uncommitted and report that explicitly; never absorb pre-existing changes into a task commit.

---

### Task 1: Add the model-catalog domain service

**Files:**
- Create: `packages/ai/model-catalog.ts`
- Create: `packages/ai/model-catalog.test.ts`
- Modify: `packages/ai/index.ts`

- [ ] **Step 1: Write failing merge, cache, freshness, and revision tests**

Use a one-model baseline, an in-memory store, a fake source, and an injected clock. Cover these cases in separate tests:

```ts
it("hydrates a newer cached overlay before serving the first snapshot", async () => {
    await store.writeProvider("openai", cachedProvider([remoteModel], 2_000));
    const catalog = createModelCatalogService({
        baseline: [baselineModel],
        generatedAt: 1_000,
        source,
        store,
        now: () => 3_000,
    });

    await catalog.hydrate();

    expect(catalog.getModel("openai", remoteModel.id)).toEqual(remoteModel);
});

it("replaces matching baseline models and appends new remote models", async () => {
    source.next("openai", updated([replacementModel, remoteModel], { lastModified: 2_000 }));
    await catalog.refreshProvider("openai", { force: true });

    expect(catalog.getModels("openai")).toEqual([replacementModel, remoteModel]);
});

it("coalesces concurrent provider refreshes", async () => {
    const first = catalog.refreshProvider("openai", { force: true });
    const second = catalog.refreshProvider("openai", { force: true });
    await Promise.all([first, second]);

    expect(source.callsFor("openai")).toBe(1);
});

it("does not emit a revision for 304 or identical model content", async () => {
    const listener = vi.fn();
    catalog.subscribe(listener);
    source.next("openai", notModified());

    await catalog.refreshProvider("openai", { force: true });

    expect(listener).not.toHaveBeenCalled();
    expect(catalog.getRevision()).toBe(0);
});
```

Also assert five-minute freshness suppression, force bypass, stale remote `Last-Modified` rejection, last-good preservation after errors, 404/501 baseline fallback, exponential retry gating, active-provider refresh, scheduler start/stop, and abort on stop.

- [ ] **Step 2: Run the service test and verify RED**

Run: `npx vitest run packages/ai/model-catalog.test.ts`

Expected: FAIL because `packages/ai/model-catalog.ts` does not exist.

- [ ] **Step 3: Define the service contracts and cache schema**

Export the domain types from `packages/ai/model-catalog.ts`:

```ts
export const ModelCatalogCacheSchemaVersion = 1;
export const ModelCatalogFreshMs = 5 * 60 * 1_000;
export const ModelCatalogRefreshIntervalMs = 60 * 60 * 1_000;

export interface ModelCatalogProviderCache {
    models: Model<Api>[];
    etag?: string;
    lastModified?: number;
    lastSuccessAt?: number;
    lastAttemptAt?: number;
    failureCount: number;
    nextRetryAt?: number;
    unavailable?: boolean;
}

export interface ModelCatalogCache {
    schemaVersion: typeof ModelCatalogCacheSchemaVersion;
    providers: Record<string, ModelCatalogProviderCache>;
}

export interface ModelCatalogStore {
    read(): Promise<ModelCatalogCache | undefined>;
    writeProvider(providerId: string, state: ModelCatalogProviderCache): Promise<void>;
    withRefreshLock<T>(providerId: string, run: () => Promise<T>): Promise<T>;
}

export type ModelCatalogSourceResult =
    | { kind: "updated"; models: Model<Api>[]; etag?: string; lastModified?: number }
    | { kind: "not-modified"; etag?: string; lastModified?: number }
    | { kind: "unavailable" };

export interface ModelCatalogSource {
    fetchProvider(input: {
        providerId: string;
        etag?: string;
        signal: AbortSignal;
    }): Promise<ModelCatalogSourceResult>;
}

export interface ModelCatalog {
    hydrate(): Promise<void>;
    getModels(providerId: string): readonly Model<Api>[];
    getModel(providerId: string, modelId: string): Model<Api> | undefined;
    getRevision(): number;
    activateProvider(providerId: string): void;
    refreshProvider(providerId: string, options?: { force?: boolean }): Promise<void>;
    refreshActive(options?: { force?: boolean }): Promise<void>;
    subscribe(listener: () => void): () => void;
    start(): void;
    stop(): void;
}
```

- [ ] **Step 4: Implement deterministic service behavior**

Implement `createModelCatalogService()` with these rules:

- Index baseline models by `(provider, id)` without mutating imported objects.
- Hydrate once; ignore invalid schema versions and provider records that fail model validation.
- Ignore cached/remote overlays whose `lastModified` is not newer than `generatedAt` when both timestamps exist.
- Merge by ID: a remote record replaces a baseline record; a new record appends in remote order.
- Keep one in-flight promise per provider.
- Re-read store state inside the provider-scoped `withRefreshLock(providerId, ...)` callback and perform a second freshness/backoff check before network access.
- Only replace memory and disk models after a fully valid `updated` result.
- Increment `revision` and notify subscribers once only when the merged model content changes.
- Treat 304 as a successful freshness update without revision; treat unavailable as baseline-only availability knowledge.
- Preserve last-good models on all exceptions and calculate retry delay as `min(60 minutes, 2 ** (failureCount - 1) * 60 seconds)`.
- Use injected `setInterval`, `clearInterval`, and `now` dependencies in tests; call `unref()` when the production timer supports it.

Export the new module from `packages/ai/index.ts`:

```ts
export * from "./model-catalog";
```

- [ ] **Step 5: Run the service test and verify GREEN**

Run: `npx vitest run packages/ai/model-catalog.test.ts`

Expected: PASS with no real timers or network requests.

- [ ] **Step 6: Commit the core domain**

```bash
git add packages/ai/model-catalog.ts packages/ai/model-catalog.test.ts packages/ai/index.ts
git commit -m "feat(ai): add shared desktop model catalog service"
```

### Task 2: Add the validated pi.dev catalog source

**Files:**
- Create: `packages/ai/pi-model-catalog-source.ts`
- Create: `packages/ai/pi-model-catalog-source.test.ts`

- [ ] **Step 1: Write failing HTTP and validation tests**

Cover array, `{ models: [...] }`, and object-map response envelopes; provider normalization; ETag request/response handling; Last-Modified parsing; 304; 404/501; malformed records; timeout; two transient retries; and no retry for validation or other 4xx failures.

```ts
it("requests the provider catalog with its validator", async () => {
    fetchMock.mockResolvedValue(jsonResponse([remoteModel], {
        etag: '"v2"',
        "last-modified": "Sun, 02 Aug 2026 12:00:00 GMT",
    }));

    const result = await source.fetchProvider({
        providerId: "openai",
        etag: '"v1"',
        signal: new AbortController().signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
        "https://pi.dev/api/models/providers/openai",
        expect.objectContaining({
            headers: expect.objectContaining({ "if-none-match": '"v1"' }),
        })
    );
    expect(result).toMatchObject({ kind: "updated", etag: '"v2"' });
});
```

- [ ] **Step 2: Run the source test and verify RED**

Run: `npx vitest run packages/ai/pi-model-catalog-source.test.ts`

Expected: FAIL because the source module does not exist.

- [ ] **Step 3: Implement the source**

Export a factory with injectable I/O:

```ts
export interface PiModelCatalogSourceOptions {
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    maxRetries?: number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    random?: () => number;
    userAgent?: string;
}

export function createPiModelCatalogSource(
    options: PiModelCatalogSourceOptions = {}
): ModelCatalogSource;
```

Use `https://pi.dev` by default, a 10-second per-attempt abort timeout, and at most two retries after the initial attempt. Retry network errors, timeouts, 408, 429, and 5xx with exponential delay plus bounded jitter. Link the caller signal to every attempt. Validate every returned model before returning `kind: "updated"`; require all request-building fields used by `@crest/ai` (`id`, `name`, `api`, `provider`, `baseUrl`, `reasoning`, `input`, `cost`, `contextWindow`, and `maxTokens`) and reject the entire body if any record is invalid.

Normalize every valid model's `provider` to the requested provider ID, matching the existing pi catalog behavior.

- [ ] **Step 4: Run the source tests and verify GREEN**

Run: `npx vitest run packages/ai/pi-model-catalog-source.test.ts`

Expected: PASS; retry tests use an injected sleep and complete immediately.

- [ ] **Step 5: Commit the source**

```bash
git add packages/ai/pi-model-catalog-source.ts packages/ai/pi-model-catalog-source.test.ts
git commit -m "feat(ai): add pi model catalog source"
```

### Task 3: Add the Electron locked atomic catalog store

**Files:**
- Create: `emain/model-catalog-store.ts`
- Create: `emain/model-catalog-store.test.ts`

- [ ] **Step 1: Write failing file-store tests**

Use a temporary directory and cover missing file, valid read/write, unknown schema, malformed JSON, concurrent writers, stale lock recovery, same-directory temporary files, atomic rename, and temporary-file cleanup after a failed rename.

```ts
it("preserves providers written by concurrent store instances", async () => {
    const first = new FileModelCatalogStore(cachePath);
    const second = new FileModelCatalogStore(cachePath);

    await Promise.all([
        first.writeProvider("openai", providerState(openaiModel)),
        second.writeProvider("anthropic", providerState(anthropicModel)),
    ]);

    await expect(first.read()).resolves.toMatchObject({
        providers: { openai: {}, anthropic: {} },
    });
});
```

- [ ] **Step 2: Run the store test and verify RED**

Run: `npx vitest run emain/model-catalog-store.test.ts`

Expected: FAIL because the store module does not exist.

- [ ] **Step 3: Implement file locking and atomic replacement**

Implement `FileModelCatalogStore implements ModelCatalogStore` using `fs.open(lockPath, "wx")`. Use one sibling write lock (`model-catalog.json.write.lock`) for read-modify-write operations and one sanitized provider-scoped refresh lock (`model-catalog.json.refresh-${encodeURIComponent(providerId)}.lock`) for cross-process network coalescing. Retry lock acquisition with a bounded short delay; remove a lock only after confirming its mtime exceeds two minutes, which is longer than the configured request/retry budget. Never use unresolved globs or broad paths.

Inside the lock:

1. Re-read and validate the current document.
2. Apply the single provider update without dropping other providers.
3. Write JSON to `model-catalog.json.tmp-${process.pid}-${uniqueSuffix}` in the same directory.
4. `fsync` and close the temporary file.
5. Rename it over `model-catalog.json`.
6. Remove the exact temporary path on failure.
7. Close and unlink the exact lock file in `finally`.

`withRefreshLock(providerId, run)` holds only that provider's refresh lock. The callback may safely call `read()` and `writeProvider()`, which use atomic reads and the separate global write lock. This prevents duplicate cross-process fetches without serializing network refreshes for unrelated providers or introducing nested-lock deadlocks.

- [ ] **Step 4: Run the store tests and verify GREEN**

Run: `npx vitest run emain/model-catalog-store.test.ts`

Expected: PASS with no files left outside the test directory.

- [ ] **Step 5: Commit the Electron store**

```bash
git add emain/model-catalog-store.ts emain/model-catalog-store.test.ts
git commit -m "feat(electron): persist model catalog atomically"
```

### Task 4: Compose and own the catalog in Electron

**Files:**
- Create: `emain/model-catalog.ts`
- Create: `emain/model-catalog.test.ts`
- Modify: `emain/emain.ts`
- Modify: `emain/emain-ipc.ts`

- [ ] **Step 1: Write failing composition and lifecycle tests**

Test that the composition root uses `getWaveDataDir()/model-catalog.json`, that cached hydration completes before IPC registration, that configured providers are activated, that initial refresh is fire-and-forget, and that shutdown stops timers/aborts requests.

```ts
expect(callOrder).toEqual([
    "catalog.hydrate",
    "ipc.register",
    "catalog.activate-configured",
    "catalog.start",
    "catalog.refresh-active",
]);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run emain/model-catalog.test.ts`

Expected: FAIL because Electron does not compose a catalog service.

- [ ] **Step 3: Implement the Electron singleton and lifecycle helpers**

In `emain/model-catalog.ts`, build the baseline from the desktop registry lazily after wavesrv has reported its version:

```ts
let desktopModelCatalog: ModelCatalog | undefined;

export async function initializeDesktopModelCatalog(): Promise<ModelCatalog> {
    if (!desktopModelCatalog) {
        const baseline = getProviders().flatMap((provider) => getModels(provider as never) as Model<Api>[]);
        desktopModelCatalog = createModelCatalogService({
            baseline,
            source: createPiModelCatalogSource({ userAgent: `Crest/${getWaveVersion().version}` }),
            store: new FileModelCatalogStore(path.join(getWaveDataDir(), "model-catalog.json")),
        });
        await desktopModelCatalog.hydrate();
    }
    return desktopModelCatalog;
}
```

Also export `startDesktopModelCatalog(userConfig)` and `stopDesktopModelCatalog()`. Hydration is allowed to await disk only. Starting activates `Object.keys(userConfig?.providers ?? {})`, starts the hourly scheduler, and launches `refreshActive()` without awaiting it.

- [ ] **Step 4: Pass the service through the desktop composition root**

Change `initIpcHandlers()` to accept `ModelCatalog`. In `appMain()`:

```ts
const modelCatalog = await initializeDesktopModelCatalog();
initIpcHandlers(modelCatalog);
```

Read `readAIUserConfig()` after IPC registration, pass `result.config` only when `result.status === "ok"`, and call `startDesktopModelCatalog()` without awaiting network work. Replace the models.dev startup call with this unified active-provider refresh. Call `stopDesktopModelCatalog()` synchronously in the accepted `before-quit` path before asynchronous Agent cleanup begins.

- [ ] **Step 5: Run the lifecycle tests and verify GREEN**

Run: `npx vitest run emain/model-catalog.test.ts emain/emain-terminal-surface.test.ts`

Expected: PASS; no test waits for an hourly timer.

- [ ] **Step 6: Commit Electron ownership**

```bash
git add emain/model-catalog.ts emain/model-catalog.test.ts emain/emain.ts emain/emain-ipc.ts
git commit -m "feat(electron): own shared model catalog lifecycle"
```

### Task 5: Move registry IPC to the service and delete models.dev overlay

**Files:**
- Modify: `emain/aiconfig/list-provider-models.ts`
- Modify: `emain/aiconfig/list-provider-models.test.ts`
- Modify: `emain/aiconfig-ipc.ts`
- Create: `emain/aiconfig-ipc.test.ts`
- Modify: `emain/preload.ts`
- Modify: `frontend/types/custom.d.ts`
- Delete: `emain/models-dev-overlay.ts`

- [ ] **Step 1: Write failing registry mapping and IPC tests**

Assert `listRegistryModels(catalog, provider)` maps the service snapshot, not `getModels()` or a capability overlay. Assert normal listing freshness-gates, force refresh bypasses freshness, and `/models` never calls catalog mutation methods.

```ts
expect(await registryHandler({}, "openai")).toEqual([
    expect.objectContaining({ id: "gpt-next", context: 250_000, reasoning: true }),
]);
expect(catalog.activateProvider).toHaveBeenCalledWith("openai");

await refreshRegistryHandler({}, "openai");
expect(catalog.refreshProvider).toHaveBeenCalledWith("openai", { force: true });
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run emain/aiconfig/list-provider-models.test.ts emain/aiconfig-ipc.test.ts`

Expected: FAIL because registry listing still imports the static registry and models.dev overlay.

- [ ] **Step 3: Make registry listing a pure service projection**

Change the signature to:

```ts
export function listRegistryModels(catalog: ModelCatalog, provider: string): RegistryModelInfo[] {
    return catalog.getModels(provider).map(toRegistryModelInfo);
}
```

Keep `listProviderModels()` and its HTTP decoders unchanged except for fixing the existing IPC forwarding bug: pass `modelsendpoint` and `tokensecretname` through to `listProviderModels()` so account discovery retains its declared endpoint behavior.

- [ ] **Step 4: Add list and force-refresh IPC**

Change `registerAiConfigIpcHandlers(catalog)` and register:

```ts
"ai:list-registry-models"    // activate; freshness-gated refresh; return snapshot
"ai:refresh-registry-models" // activate; force refresh; return snapshot
```

Expose both methods in preload and add `RegistryModelInfo` plus both function signatures to `frontend/types/custom.d.ts`.

- [ ] **Step 5: Delete the obsolete overlay**

Delete `emain/models-dev-overlay.ts`, remove its mock from tests, and verify there are no remaining references:

Run: `rg -n "models-dev-overlay|initModelsDevOverlay|getCapabilityOverlay" emain frontend packages`

Expected: no matches.

- [ ] **Step 6: Run IPC tests and verify GREEN**

Run: `npx vitest run emain/aiconfig/list-provider-models.test.ts emain/aiconfig-ipc.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit the IPC migration**

```bash
git add emain/aiconfig/list-provider-models.ts emain/aiconfig/list-provider-models.test.ts emain/aiconfig-ipc.ts emain/aiconfig-ipc.test.ts emain/models-dev-overlay.ts
git add -p emain/preload.ts frontend/types/custom.d.ts
git commit -m "refactor(electron): serve registry models from shared catalog"
```

### Task 6: Make Agent IPC resolve models through the shared service

**Files:**
- Modify: `emain/agent-ipc.ts`
- Modify: `emain/agent-ipc.test.ts`
- Modify: `emain/emain-ipc.ts`

- [ ] **Step 1: Add failing request-resolution tests**

Replace the `@crest/ai.getModel` mock with a catalog dependency in the Agent IPC test registration helper. Cover a known model, a missing model found after on-demand refresh, an unknown model after refresh, and a second send on an existing session receiving updated model metadata.

```ts
it("uses refreshed catalog metadata on the next send of an existing session", async () => {
    catalog.getModel.mockReturnValueOnce(oldModel).mockReturnValueOnce(refreshedModel);

    await send("first");
    await send("second");

    expect(sendConfiguredSpy).toHaveBeenLastCalledWith(
        "second",
        expect.objectContaining({ model: refreshedModel }),
        expect.anything()
    );
});
```

- [ ] **Step 2: Run Agent IPC tests and verify RED**

Run: `npx vitest run emain/agent-ipc.test.ts`

Expected: FAIL because `resolveModelOrThrow()` still calls static `getModel()`.

- [ ] **Step 3: Inject and use `ModelCatalog`**

Add `modelCatalog: ModelCatalog` to `AgentIpcRegistrationOptions` and pass the Electron singleton from `initIpcHandlers()`.

Make resolution asynchronous:

```ts
async function resolveModelOrThrow(catalog: ModelCatalog, provider: string, modelId: string): Promise<Model<Api>> {
    catalog.activateProvider(provider);
    const cached = catalog.getModel(provider, modelId);
    if (cached) {
        void catalog.refreshProvider(provider).catch((error) => {
            console.log(`[agent-ipc] model catalog refresh failed for ${provider}`, error);
        });
        return cached;
    }
    await catalog.refreshProvider(provider);
    const refreshed = catalog.getModel(provider, modelId);
    if (!refreshed) throw new Error(`agent: unknown provider/model "${provider}/${modelId}"`);
    return refreshed;
}
```

Use the injected catalog inside `resolveAgentExecution()`. Do not accept endpoint, API type, capabilities, context, or pricing from renderer IPC input. Existing `AgentSessionRuntime.syncExecutionConfig()` remains the single mechanism that applies a changed model to a live `AgentHarness`.

- [ ] **Step 4: Run Agent IPC tests and verify GREEN**

Run: `npx vitest run emain/agent-ipc.test.ts packages/coding-agent/agent-session-runtime.test.ts`

Expected: PASS, including the existing live model-switch coverage.

- [ ] **Step 5: Commit Agent resolution**

```bash
git add emain/emain-ipc.ts
git add -p emain/agent-ipc.ts emain/agent-ipc.test.ts
git commit -m "refactor(agent): resolve models through desktop catalog"
```

### Task 7: Add renderer registry state and catalog projection

**Files:**
- Create: `frontend/app/store/ai-registry-models.ts`
- Create: `frontend/app/store/ai-registry-models.test.ts`
- Modify: `frontend/app/store/ai-catalog.ts`
- Modify: `frontend/app/store/ai-catalog.test.ts`
- Modify: `frontend/app/store/ai-resolver.test.ts`

- [ ] **Step 1: Write failing renderer-state and projection tests**

Test per-provider request coalescing, cached reads, force refresh, error preservation, and projection precedence. The key projection test must prove that registry capability facts win while renderer-only capability facts survive when Electron cannot express them:

```ts
expect(projectRegistryModels(staticProvider, [registryModel])).toEqual({
    ...staticProvider,
    models: [
        expect.objectContaining({
            id: registryModel.id,
            displayName: registryModel.name,
            contextWindow: registryModel.context,
            capabilities: ["tools", "images", "pdfs", "reasoning"],
        }),
    ],
});
```

For a new registry-only model, derive `tools`, `images`, and `reasoning` only from known registry facts; do not invent `pdfs`. Limit renderer reasoning levels to its supported `low | medium | high` union.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run frontend/app/store/ai-registry-models.test.ts frontend/app/store/ai-catalog.test.ts frontend/app/store/ai-resolver.test.ts`

Expected: FAIL because no renderer registry state or projection exists.

- [ ] **Step 3: Implement Jotai registry state**

Mirror the proven per-provider pattern from `ai-provider-models.ts`, but keep catalog facts separate from availability:

```ts
export interface RegistryModelsState {
    status: "idle" | "loading" | "ok" | "error";
    models: RegistryModelInfo[];
    error?: string;
    fetchedAt: number | null;
}

export const registryModelsMapAtom = atom<Record<string, RegistryModelsState>>({});
export function registryModelsAtomFor(providerId: string): Atom<RegistryModelsState>;
export function fetchRegistryModels(providerId: string): Promise<void>;
export function refreshRegistryModels(providerId: string): Promise<void>;
```

Normal fetch calls `listRegistryModels`; force refresh calls `refreshRegistryModels`. Preserve prior models when refresh fails.

- [ ] **Step 4: Implement pure catalog projection helpers**

Add these helpers to `ai-catalog.ts`:

```ts
export function projectRegistryModels(
    provider: ProviderEntry,
    registryModels: readonly RegistryModelInfo[]
): ProviderEntry;

export function projectRegistryCatalog(
    catalog: readonly ProviderEntry[],
    states: Readonly<Record<string, RegistryModelsState>>
): ProviderEntry[];
```

Use the passed catalog in all lookups. Do not call global `findModel()` from helpers that already receive a catalog/provider; this fixes the current custom-catalog leakage in pinned rows and tests.

- [ ] **Step 5: Run state and resolver tests and verify GREEN**

Run: `npx vitest run frontend/app/store/ai-registry-models.test.ts frontend/app/store/ai-catalog.test.ts frontend/app/store/ai-resolver.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit renderer catalog state**

```bash
git add frontend/app/store/ai-registry-models.ts frontend/app/store/ai-registry-models.test.ts frontend/app/store/ai-catalog.ts frontend/app/store/ai-catalog.test.ts frontend/app/store/ai-resolver.test.ts
git commit -m "feat(renderer): project Electron model catalog"
```

### Task 8: Drive picker, resolver, and manual refresh from the projection

**Files:**
- Modify: `frontend/app/view/cmdblock/model-picker-popover.tsx`
- Modify: `frontend/app/view/cmdblock/model-picker-popover.test.tsx`
- Modify: `frontend/app/store/ai-provider-models.ts`
- Create: `frontend/app/store/ai-provider-models.test.ts`
- Modify: `frontend/app/agent/agent-content.tsx`
- Modify: `frontend/app/agent/agent-content.test.tsx`

- [ ] **Step 1: Add failing picker and AgentContent tests**

Assert that opening a provider tab launches both independent reads, the refresh button forces both reads, picker rows use registry metadata filtered by `/models` availability, and `AgentContent` resolves the selected model with the projected context window.

```ts
expect(fetchRegistryModels).toHaveBeenCalledWith("openai");
expect(fetchProviderModels).toHaveBeenCalledWith("openai", userConfig);

expect(refreshRegistryModels).toHaveBeenCalledWith("openai");
expect(refreshProviderModels).toHaveBeenCalledWith("openai", userConfig);

expect(agentChatHostProps.modelContextWindow).toBe(250_000);
```

Also assert a `/models`-only ID appears as provisional with unknown catalog fields and does not get written into `registryModelsMapAtom`.

- [ ] **Step 2: Run focused UI tests and verify RED**

Run: `npx vitest run frontend/app/view/cmdblock/model-picker-popover.test.tsx frontend/app/store/ai-provider-models.test.ts frontend/app/agent/agent-content.test.tsx`

Expected: FAIL because the picker and resolver still consume `CATALOG` directly.

- [ ] **Step 3: Fetch catalog facts and availability independently**

In both picker variants, when a provider tab activates:

```ts
void Promise.all([
    fetchRegistryModels(tab.providerId),
    fetchProviderModels(tab.providerId, userConfig),
]);
```

The refresh button uses both force methods. Keep loading/error state independent so a provider `/models` authentication failure cannot erase catalog facts and a pi.dev failure cannot erase availability.

- [ ] **Step 4: Use the projected catalog everywhere in the model UI**

Compute `effectiveCatalog = projectRegistryCatalog(catalog, registryModelsMap)` and pass it to tabs, pinned rows, provider rows, model labels, and `resolveAIConfig()`. Replace remaining global `findProvider()`/`findModel()` calls in catalog-parameterized paths with lookups against `effectiveCatalog`.

In `AgentContent`, subscribe to `registryModelsMapAtom`, fetch the selected provider after user config/selection resolution, and use the projected catalog for:

- model display label;
- `resolveAIConfig()`;
- `modelContextWindow` passed to `AgentChatHost`;
- the `catalog` prop passed to `ModelPickerInline`.

The renderer continues sending only provider, model, reasoning, and credential reference to Electron.

- [ ] **Step 5: Clarify `/models` naming and comments**

Update comments in `ai-provider-models.ts`, picker code, and `ModelsSection.tsx` so `/models` is consistently described as account/deployment availability discovery. Do not call it the authoritative capability catalog.

- [ ] **Step 6: Run focused UI tests and verify GREEN**

Run: `npx vitest run frontend/app/view/cmdblock/model-picker-popover.test.tsx frontend/app/store/ai-provider-models.test.ts frontend/app/store/ai-resolver.test.ts frontend/app/agent/agent-content.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit renderer integration**

```bash
git add frontend/app/view/cmdblock/model-picker-popover.tsx frontend/app/view/cmdblock/model-picker-popover.test.tsx frontend/app/store/ai-provider-models.ts frontend/app/store/ai-provider-models.test.ts
git add -p frontend/app/agent/agent-content.tsx frontend/app/agent/agent-content.test.tsx
git commit -m "refactor(renderer): use shared model catalog metadata"
```

### Task 9: Verify convergence and remove stale documentation

**Files:**
- Modify: `docs/ai-config-architecture.md`
- Modify: `packages/ai/models.generated.ts` (header comments only)
- Verify: all files changed in Tasks 1-8

- [ ] **Step 1: Update architecture comments**

Document the final split explicitly:

```text
pi.dev + generated snapshot -> Electron ModelCatalogService -> registry IPC + agent-ipc
provider /models            -> credential/deployment availability only
renderer generated models  -> first-paint/offline compatibility fallback only
```

Remove claims that the frontend static catalog or models.dev overlay is the runtime source of truth. Do not edit or delete `packages/coding-agent/src/core/remote-catalog-provider.ts`.

- [ ] **Step 2: Run the complete focused regression set**

Run:

```bash
npx vitest run \
  packages/ai/model-catalog.test.ts \
  packages/ai/pi-model-catalog-source.test.ts \
  emain/model-catalog-store.test.ts \
  emain/model-catalog.test.ts \
  emain/aiconfig/list-provider-models.test.ts \
  emain/aiconfig-ipc.test.ts \
  emain/agent-ipc.test.ts \
  packages/coding-agent/agent-session-runtime.test.ts \
  frontend/app/store/ai-registry-models.test.ts \
  frontend/app/store/ai-provider-models.test.ts \
  frontend/app/store/ai-resolver.test.ts \
  frontend/app/view/cmdblock/model-picker-popover.test.tsx \
  frontend/app/agent/agent-content.test.tsx
```

Expected: all focused suites PASS with no unhandled rejection or real-network access.

- [ ] **Step 3: Run build and formatting verification**

Run: `npx prettier --check packages/ai/model-catalog.ts packages/ai/pi-model-catalog-source.ts emain/model-catalog-store.ts emain/model-catalog.ts emain/aiconfig/list-provider-models.ts emain/aiconfig-ipc.ts emain/agent-ipc.ts frontend/app/store/ai-registry-models.ts frontend/app/store/ai-provider-models.ts frontend/app/store/ai-catalog.ts frontend/app/agent/agent-content.tsx frontend/app/view/cmdblock/model-picker-popover.tsx`

Expected: all listed files use project formatting.

Run: `npm run build:dev`

Expected: Electron main, preload, and renderer builds succeed.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 4: Verify architectural cleanup**

Run: `rg -n "models-dev-overlay|initModelsDevOverlay|getCapabilityOverlay" emain frontend packages`

Expected: no matches.

Run: `rg -n "remote-catalog-provider" packages/coding-agent/src/core/model-runtime.ts`

Expected: the inherited CLI reference still exists and has not been modified by this desktop work.

Run: `git diff --name-only d0f0b50b..HEAD`

Expected: no implementation changes under `packages/coding-agent/src/`; desktop runtime changes are limited to root `packages/coding-agent` files already used by `AgentHarness`, if any.

- [ ] **Step 5: Commit final documentation**

```bash
git add docs/ai-config-architecture.md packages/ai/models.generated.ts
git commit -m "docs: document desktop model catalog ownership"
```
