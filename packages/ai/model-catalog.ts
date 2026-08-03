// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Api, Model } from "./types";

export const ModelCatalogCacheSchemaVersion = 1;
export const ModelCatalogFreshMs = 5 * 60 * 1_000;
export const ModelCatalogRefreshIntervalMs = 60 * 60 * 1_000;

const ModelCatalogRetryBaseMs = 60 * 1_000;
const ModelCatalogRetryMaxMs = 60 * 60 * 1_000;

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
    fetchProvider(input: { providerId: string; etag?: string; signal: AbortSignal }): Promise<ModelCatalogSourceResult>;
}

export interface ModelCatalog {
    hydrate(): Promise<void>;
    getModels(providerId: string): readonly Model<Api>[];
    getModel(providerId: string, modelId: string): Model<Api> | undefined;
    getRevision(): number;
    activateProvider(providerId: string): void;
    refreshProvider(providerId: string, options?: { force?: boolean }): Promise<void>;
    refreshActive(options?: { force?: boolean }): Promise<void>;
    subscribe(listener: (providerId: string) => void): () => void;
    start(): void;
    stop(): void;
}

export interface CreateModelCatalogServiceOptions {
    baseline: readonly Model<Api>[];
    generatedAt?: number;
    source: ModelCatalogSource;
    store: ModelCatalogStore;
    now?: () => number;
    setInterval?: (callback: () => void, interval: number) => unknown;
    clearInterval?: (timer: unknown) => void;
}

export function createModelCatalogService(options: CreateModelCatalogServiceOptions): ModelCatalog {
    const baseline = indexBaseline(options.baseline);
    const providerStates = new Map<string, ModelCatalogProviderCache>();
    const activeProviders = new Set<string>();
    const listeners = new Set<(providerId: string) => void>();
    const inFlight = new Map<string, Promise<void>>();
    const controllers = new Map<string, AbortController>();
    const now = options.now ?? Date.now;
    const scheduleInterval = options.setInterval ?? globalThis.setInterval;
    const cancelInterval: (timer: unknown) => void =
        options.clearInterval ??
        ((activeTimer) => globalThis.clearInterval(activeTimer as ReturnType<typeof globalThis.setInterval>));
    let revision = 0;
    let hydratePromise: Promise<void> | undefined;
    let timer: unknown;

    function mergedModels(providerId: string, state = providerStates.get(providerId)): Model<Api>[] {
        const providerBaseline = baseline.get(providerId) ?? [];
        if (!state || state.unavailable || !isOverlayNewer(state.lastModified, options.generatedAt)) {
            return providerBaseline;
        }
        return mergeModels(providerBaseline, state.models);
    }

    function applyProviderState(providerId: string, state: ModelCatalogProviderCache): void {
        if (!isProviderCache(state)) return;
        const before = mergedModels(providerId);
        providerStates.set(providerId, clone(state));
        const after = mergedModels(providerId);
        if (sameModels(before, after)) return;
        revision += 1;
        for (const listener of listeners) {
            try {
                listener(providerId);
            } catch {
                continue;
            }
        }
    }

    async function hydrate(): Promise<void> {
        if (hydratePromise) return hydratePromise;
        hydratePromise = (async () => {
            const cached = await options.store.read();
            if (!isCatalogCacheDocument(cached)) return;
            for (const [providerId, state] of Object.entries(cached.providers)) {
                if (!isProviderCache(state) || !isOverlayNewer(state.lastModified, options.generatedAt)) continue;
                providerStates.set(providerId, clone(state));
            }
        })();
        return hydratePromise;
    }

    async function runRefresh(providerId: string, force: boolean): Promise<void> {
        await options.store.withRefreshLock(providerId, async () => {
            const cached = await options.store.read();
            const diskState = isCatalogCacheDocument(cached) ? cached.providers[providerId] : undefined;
            if (diskState && isProviderCache(diskState)) applyProviderState(providerId, diskState);

            const state = providerStates.get(providerId);
            const currentTime = now();
            if (!force && shouldSuppressRefresh(state, currentTime)) return;

            const controller = new AbortController();
            controllers.set(providerId, controller);
            try {
                const result = await options.source.fetchProvider({
                    providerId,
                    etag: state?.etag,
                    signal: controller.signal,
                });
                const nextState = successfulState(state, result, currentTime, options.generatedAt);
                await options.store.writeProvider(providerId, nextState);
                applyProviderState(providerId, nextState);
            } catch (error) {
                const nextState = failedState(state, currentTime);
                await options.store.writeProvider(providerId, nextState);
                applyProviderState(providerId, nextState);
                throw error;
            } finally {
                if (controllers.get(providerId) === controller) controllers.delete(providerId);
            }
        });
    }

    async function refreshProvider(providerId: string, options?: { force?: boolean }): Promise<void> {
        const normalizedProviderId = providerId.trim();
        if (!normalizedProviderId) return;
        const existing = inFlight.get(normalizedProviderId);
        if (existing) return existing;
        const refresh = runRefresh(normalizedProviderId, options?.force === true).finally(() => {
            if (inFlight.get(normalizedProviderId) === refresh) inFlight.delete(normalizedProviderId);
        });
        inFlight.set(normalizedProviderId, refresh);
        return refresh;
    }

    async function refreshActive(options?: { force?: boolean }): Promise<void> {
        await Promise.all(Array.from(activeProviders, (providerId) => refreshProvider(providerId, options)));
    }

    return {
        hydrate,
        getModels(providerId) {
            return mergedModels(providerId);
        },
        getModel(providerId, modelId) {
            return mergedModels(providerId).find((model) => model.id === modelId);
        },
        getRevision() {
            return revision;
        },
        activateProvider(providerId) {
            const normalizedProviderId = providerId.trim();
            if (normalizedProviderId) activeProviders.add(normalizedProviderId);
        },
        refreshProvider,
        refreshActive,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        start() {
            if (timer !== undefined) return;
            timer = scheduleInterval(() => {
                void refreshActive().catch(() => undefined);
            }, ModelCatalogRefreshIntervalMs);
            if (hasUnref(timer)) timer.unref();
        },
        stop() {
            if (timer !== undefined) {
                cancelInterval(timer);
                timer = undefined;
            }
            for (const controller of controllers.values()) controller.abort();
            controllers.clear();
        },
    };
}

function indexBaseline(models: readonly Model<Api>[]): Map<string, Model<Api>[]> {
    const providers = new Map<string, Model<Api>[]>();
    for (const sourceModel of models) {
        const model = clone(sourceModel);
        const providerModels = providers.get(model.provider) ?? [];
        providerModels.push(model);
        providers.set(model.provider, providerModels);
    }
    return providers;
}

function mergeModels(baseline: readonly Model<Api>[], overlay: readonly Model<Api>[]): Model<Api>[] {
    const replacements = new Map(overlay.map((model) => [model.id, model]));
    const baselineIds = new Set(baseline.map((model) => model.id));
    return [
        ...baseline.map((model) => replacements.get(model.id) ?? model),
        ...overlay.filter((model) => !baselineIds.has(model.id)),
    ];
}

function successfulState(
    previous: ModelCatalogProviderCache | undefined,
    result: ModelCatalogSourceResult,
    currentTime: number,
    generatedAt: number | undefined
): ModelCatalogProviderCache {
    if (result.kind === "not-modified") {
        return {
            models: previous?.models ?? [],
            etag: result.etag ?? previous?.etag,
            lastModified: result.lastModified ?? previous?.lastModified,
            lastSuccessAt: currentTime,
            lastAttemptAt: currentTime,
            failureCount: 0,
            unavailable: false,
        };
    }
    if (result.kind === "unavailable") {
        return {
            models: [],
            lastSuccessAt: currentTime,
            lastAttemptAt: currentTime,
            failureCount: 0,
            unavailable: true,
        };
    }
    if (!result.models.every(isModel)) throw new Error("model catalog source returned invalid models");
    if (!isOverlayNewer(result.lastModified, generatedAt)) {
        return {
            ...(previous ?? { models: [], failureCount: 0 }),
            lastSuccessAt: currentTime,
            lastAttemptAt: currentTime,
            failureCount: 0,
            nextRetryAt: undefined,
        };
    }
    return {
        models: clone(result.models),
        etag: result.etag,
        lastModified: result.lastModified,
        lastSuccessAt: currentTime,
        lastAttemptAt: currentTime,
        failureCount: 0,
        unavailable: false,
    };
}

function failedState(previous: ModelCatalogProviderCache | undefined, currentTime: number): ModelCatalogProviderCache {
    const failureCount = (previous?.failureCount ?? 0) + 1;
    const retryDelay = Math.min(ModelCatalogRetryMaxMs, 2 ** (failureCount - 1) * ModelCatalogRetryBaseMs);
    return {
        ...(previous ?? { models: [] }),
        lastAttemptAt: currentTime,
        failureCount,
        nextRetryAt: currentTime + retryDelay,
    };
}

function shouldSuppressRefresh(state: ModelCatalogProviderCache | undefined, currentTime: number): boolean {
    if (!state) return false;
    if (state.nextRetryAt !== undefined && currentTime < state.nextRetryAt) return true;
    return state.lastSuccessAt !== undefined && currentTime - state.lastSuccessAt < ModelCatalogFreshMs;
}

function isOverlayNewer(lastModified: number | undefined, generatedAt: number | undefined): boolean {
    return lastModified === undefined || generatedAt === undefined || lastModified > generatedAt;
}

function isCatalogCacheDocument(value: unknown): value is ModelCatalogCache {
    if (!value || typeof value !== "object") return false;
    const cache = value as Partial<ModelCatalogCache>;
    return cache.schemaVersion === ModelCatalogCacheSchemaVersion && isRecord(cache.providers);
}

function isProviderCache(value: unknown): value is ModelCatalogProviderCache {
    if (!value || typeof value !== "object") return false;
    const state = value as Partial<ModelCatalogProviderCache>;
    return Array.isArray(state.models) && state.models.every(isModel) && Number.isInteger(state.failureCount);
}

function isModel(value: unknown): value is Model<Api> {
    if (!value || typeof value !== "object") return false;
    const model = value as Partial<Model<Api>>;
    return (
        typeof model.id === "string" &&
        typeof model.name === "string" &&
        typeof model.api === "string" &&
        typeof model.provider === "string" &&
        typeof model.baseUrl === "string" &&
        typeof model.reasoning === "boolean" &&
        Array.isArray(model.input) &&
        isCost(model.cost) &&
        typeof model.contextWindow === "number" &&
        typeof model.maxTokens === "number"
    );
}

function isCost(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const cost = value as Record<string, unknown>;
    return ["input", "output", "cacheRead", "cacheWrite"].every((key) => typeof cost[key] === "number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameModels(first: readonly Model<Api>[], second: readonly Model<Api>[]): boolean {
    return JSON.stringify(first) === JSON.stringify(second);
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

function hasUnref(value: unknown): value is { unref(): void } {
    return !!value && typeof value === "object" && "unref" in value && typeof value.unref === "function";
}
