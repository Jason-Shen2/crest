# Crest Desktop Model Catalog Convergence Design

## Status

Approved for implementation planning on 2026-08-03.

## Problem

Crest desktop currently has multiple model-data paths with overlapping responsibilities:

- `emain/models-dev-overlay.ts` fetches `models.dev/api.json`, persists a 24-hour cache, and overlays capability metadata for Electron model-picker reads.
- `packages/coding-agent/src/core/remote-catalog-provider.ts` fetches per-provider catalogs from `pi.dev`, persists a separate four-hour cache, and overlays models inside each coding-agent runtime.
- `emain/aiconfig/list-provider-models.ts` calls a provider's `/models` endpoint and returns account- or deployment-visible model IDs.
- `packages/ai/src/providers/data/` contains the generated built-in snapshot used when no dynamic data is available.

These paths use different caches, refresh triggers, error handling, and ownership. The Electron picker can therefore display model facts that differ from the model objects used by Crest Agent requests.

## Scope

This design applies only to the Crest desktop application and the Crest Agent sessions hosted by its Electron main process.

The standalone terminal CLI inherited from pi is not a product target for this work. Its startup lifecycle, cache location, periodic refresh behavior, and UX are excluded. Shared types may remain compatible where compilation requires it, but no CLI-specific behavior will be added.

This is a client-only convergence. The existing per-provider `pi.dev` catalog API remains unchanged.

## Goals

- Make one service authoritative for model catalog facts in the desktop process.
- Ensure Electron settings/model-picker reads and Crest Agent runtimes observe the same model objects.
- Keep a generated snapshot available immediately and offline.
- Refresh active provider catalogs without blocking application startup.
- Persist the last valid remote catalog safely and reuse it after failures.
- Separate global model facts from account- and deployment-specific availability.
- Remove the Electron models.dev overlay and per-runtime remote catalog state after consumers migrate.

## Non-goals

- Changing provider request protocols, authentication, or OAuth behavior.
- Changing the `pi.dev` service or adding a full-catalog endpoint.
- Making provider `/models` responses authoritative for context windows, pricing, reasoning controls, or API compatibility.
- Supporting periodic refresh for the inherited standalone CLI.
- Migrating the obsolete `models-dev-cache.json`; the generated snapshot is the fallback during the first unified refresh.
- Changing user-defined providers in `models.json`.

## Chosen Architecture

`packages/ai` will contain a single injectable `ModelCatalogService`. The package owns the model-domain rules, while Electron owns the service instance and application lifecycle.

```text
Generated provider snapshot
           +
pi.dev provider overlays
           |
           v
Electron-owned ModelCatalogService
       |                    |
       v                    v
Settings/model IPC     Crest Agent ModelRuntime
       |
       v
Provider /models availability observation
```

The Electron main process creates one service instance, starts background refresh after startup, injects the instance into every Crest Agent runtime, and stops it during shutdown. All Agent sessions in the process share the service's in-memory state.

The service remains in `packages/ai` instead of `emain` so model merging, validation, refresh, and event semantics are isolated from Electron and can be tested without creating an Electron application.

## Components

### ModelCatalogService

The service owns:

- generated baseline catalogs;
- validated remote overlays keyed by provider ID;
- merged model snapshots;
- per-provider refresh status;
- in-flight request coalescing;
- active-provider tracking;
- the hourly refresh scheduler;
- a monotonic catalog revision and update subscriptions.

Its public surface will support:

- reading one provider's current merged models;
- reading a model by provider and model ID;
- hydrating all cached overlays before the first snapshot is exposed;
- marking configured or currently viewed providers active;
- refreshing one provider or all active providers;
- forcing a manual refresh;
- subscribing to model-content changes;
- starting and stopping background scheduling.

### CatalogSource

`CatalogSource` abstracts the existing `pi.dev` HTTP API. A request includes provider ID, ETag, abort signal, and request metadata. The result is one of:

- updated catalog with validators;
- not modified;
- catalog unavailable for that provider.

The source applies a ten-second timeout and retries transient failures at most twice using exponential backoff with jitter. HTTP 200 bodies must pass complete model-schema validation before they can update memory or disk.

### CatalogStore

`CatalogStore` persists one versioned document in the Wave data directory, provisionally named `model-catalog.json`.

Each provider entry contains:

- the validated remote model overlay;
- ETag and Last-Modified validators;
- `lastSuccessAt`;
- `lastAttemptAt`;
- consecutive failure count;
- next allowed retry time.

The file adapter uses a cross-process lock. Writes go to a uniquely named temporary file in the same directory and replace the destination with an atomic rename. An unsupported schema version or invalid JSON is ignored as a cache miss; it never prevents snapshot startup.

### Electron Composition Root

Electron creates the service using:

- the generated catalogs from `packages/ai`;
- a `pi.dev` source;
- a file store under `getWaveDataDir()`;
- the production clock and scheduler.

It hydrates cached overlays before Agent runtimes are created, but network refresh is fire-and-forget and does not block window creation.

### ModelRuntime Integration

`ModelRuntime` receives the shared catalog service. It no longer wraps every provider with a private `dynamicModels` closure.

Provider authentication and streaming remain in the runtime. Provider model lists are projections of the shared catalog snapshot plus user configuration. A catalog revision causes the runtime to rebuild its provider/model snapshot and availability projection without replacing the catalog service.

### Electron Model IPC

`listRegistryModels(provider)` reads the shared catalog snapshot and maps it into the renderer's existing response type. It no longer reads a separate models.dev overlay.

The existing `listProviderModels()` call remains an account-availability operation. Its response is ephemeral and scoped to the current provider credentials or custom endpoint.

## Catalog Facts Versus Availability

The unified catalog answers: "What is this model?"

It owns model ID, display name, API type, context limits, reasoning controls, modalities, compatibility metadata, and cost.

Provider `/models` answers: "Can this account or deployment currently see this model?"

The picker combines the two observations as follows:

- Present in both: show the model with unified catalog metadata.
- Present only in the catalog: hide or mark unavailable when that provider's `/models` response is considered authoritative for the account.
- Present only in `/models`: show a provisional discovered entry with unknown capabilities; do not invent context, cost, or reasoning metadata and do not persist it into the global catalog.
- Provider has no usable `/models` endpoint: use catalog entries without an availability filter.

Azure deployment aliases, enterprise gateway aliases, and subscription-specific model IDs therefore cannot contaminate the global model catalog.

## Merge Rules

For a provider, the merged catalog starts with the generated baseline.

- A valid remote model with the same ID replaces the baseline model.
- A valid remote model with a new ID is appended.
- A remote catalog whose `Last-Modified` value is not newer than the generated snapshot is ignored.
- User-defined provider and model configuration remains a higher-level runtime overlay and is not written into the catalog cache.
- Invalid remote records reject the entire provider response so a partially valid response cannot erase known-good facts.

## Refresh Lifecycle

1. Electron creates the service and loads the generated baseline.
2. The service hydrates the unified disk cache.
3. Electron and Agent consumers can immediately read the merged snapshot.
4. After startup, Electron activates configured and currently used providers and starts a non-blocking refresh.
5. A provider checked successfully within five minutes is considered fresh.
6. The scheduler revisits active providers every hour.
7. Opening settings for an inactive provider activates and refreshes that provider on demand.
8. A manual refresh bypasses freshness and retry-backoff gates.
9. Electron stops scheduling and aborts outstanding work during shutdown.

Only active providers are refreshed because the current `pi.dev` API is per-provider. Requests are bounded to a small concurrency so startup cannot issue every provider request simultaneously.

## Failure Semantics

- Network, timeout, 5xx, and validation failures leave the current memory and disk model overlay unchanged.
- Failure updates `lastAttemptAt`, failure count, and retry timing, but never advances `lastSuccessAt`.
- Retry delay grows exponentially up to one hour; a manual refresh bypasses it.
- HTTP 304 updates successful freshness without incrementing the catalog revision.
- HTTP 404 or 501 records that the remote source has no provider catalog while retaining the generated baseline.
- A model-content change increments the service revision and notifies subscribers once.
- Concurrent refreshes for the same provider share one promise in-process.
- The file lock and a second freshness check after lock acquisition prevent duplicate cross-process refreshes.

## Migration Sequence

### Phase 1: Introduce the service behind tests

Add the catalog types, service, source, store contract, and fake-friendly clock/scheduler. Preserve existing consumers while the new service is proven independently.

### Phase 2: Move Crest Agent runtime reads

Inject the service into desktop-created `ModelRuntime` instances. Rebuild runtime snapshots on catalog revisions. Remove `withRemoteCatalog()` and its private dynamic state after runtime integration tests pass.

### Phase 3: Move Electron model reads

Create the Electron singleton and switch `listRegistryModels` to it. Keep `listProviderModels` as availability discovery. Remove `emain/models-dev-overlay.ts`, its startup call, and `models-dev-cache.json` references after IPC tests pass.

### Phase 4: Own the desktop lifecycle

Start active-provider refresh after application startup, wire hourly scheduling, and stop/abort it during shutdown. Remove obsolete comments and duplicate cache code.

## Testing Strategy

Core service tests use an in-memory store, fake source, controllable clock, and controllable scheduler. They cover:

- baseline plus remote merge precedence;
- new remote model discovery;
- rejection of stale and invalid remote catalogs;
- cache hydration while offline;
- five-minute freshness gating;
- forced refresh;
- ETag/304 behavior;
- transient retry and backoff;
- preservation of the last valid catalog after errors;
- in-process request coalescing;
- revision emission only when content changes;
- scheduler stop and cancellation.

File-store tests cover schema handling, file locking, temporary-file cleanup, and atomic replacement.

Integration tests cover:

- two Crest Agent sessions observing one catalog update;
- `ModelRuntime` resolving a newly published pi.dev model without an application update;
- Electron `listRegistryModels` returning the same metadata as the runtime;
- provider `/models` results affecting availability without mutating the catalog;
- offline desktop startup using cached or generated models;
- removal of the two obsolete dynamic model implementations.

No test performs a real network request or waits for a real hourly timer.

## Acceptance Criteria

- The desktop process contains one authoritative dynamic model catalog state.
- Settings/model-picker metadata and Crest Agent request metadata come from the same merged model objects.
- Window creation is not blocked by network access.
- Active provider catalogs refresh after startup and hourly, with manual force refresh available.
- A new valid pi.dev model can appear in both Electron and Crest Agent without updating the app.
- Offline and failed-refresh behavior preserves the last valid catalog or generated snapshot.
- Cache writes are locked and atomic.
- Provider `/models` observations remain credential-scoped and do not mutate persistent catalog facts.
- `emain/models-dev-overlay.ts` and `packages/coding-agent/src/core/remote-catalog-provider.ts` no longer hold dynamic catalog state.
- Standalone CLI behavior is neither changed nor required for completion.
