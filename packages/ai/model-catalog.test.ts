// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
    ModelCatalogCacheSchemaVersion,
    ModelCatalogFreshMs,
    ModelCatalogRefreshIntervalMs,
    createModelCatalogService,
    type ModelCatalogCache,
    type ModelCatalogProviderCache,
    type ModelCatalogSource,
    type ModelCatalogSourceResult,
    type ModelCatalogStore,
} from "./model-catalog";
import type { Api, Model } from "./types";

const baselineModel = model("gpt-base", { name: "GPT Base" });
const replacementModel = model("gpt-base", { name: "GPT Base Remote", contextWindow: 200_000 });
const remoteModel = model("gpt-next", { name: "GPT Next", contextWindow: 250_000 });

describe("ModelCatalogService", () => {
    it("hydrates a newer cached overlay before serving the first snapshot", async () => {
        const store = new MemoryStore();
        await store.writeProvider("openai", providerState([remoteModel], { lastModified: 2_000 }));
        const catalog = createCatalog({ store, generatedAt: 1_000, now: () => 3_000 });

        await catalog.hydrate();

        expect(catalog.getModel("openai", remoteModel.id)).toEqual(remoteModel);
    });

    it("hydrates valid providers while ignoring invalid cache records", async () => {
        const store = new MemoryStore({
            schemaVersion: ModelCatalogCacheSchemaVersion,
            providers: {
                openai: providerState([remoteModel], { lastModified: 2_000 }),
                broken: providerState([{ id: "invalid" } as Model<Api>]),
            },
        });
        const catalog = createCatalog({ store, generatedAt: 1_000 });

        await catalog.hydrate();

        expect(catalog.getModels("openai")).toEqual([baselineModel, remoteModel]);
        expect(catalog.getModels("broken")).toEqual([]);
    });

    it("replaces matching baseline models and appends new remote models", async () => {
        const source = new FakeSource();
        const catalog = createCatalog({ source });
        source.next("openai", updated([replacementModel, remoteModel], { lastModified: 2_000 }));

        await catalog.refreshProvider("openai", { force: true });

        expect(catalog.getModels("openai")).toEqual([replacementModel, remoteModel]);
    });

    it("coalesces concurrent provider refreshes", async () => {
        const source = new FakeSource();
        const pending = deferred<ModelCatalogSourceResult>();
        source.next("openai", pending.promise);
        const catalog = createCatalog({ source });

        const first = catalog.refreshProvider("openai", { force: true });
        const second = catalog.refreshProvider("openai", { force: true });
        pending.resolve(updated([remoteModel]));
        await Promise.all([first, second]);

        expect(source.callsFor("openai")).toBe(1);
    });

    it("suppresses refreshes for five minutes and force bypasses freshness", async () => {
        let currentTime = 1_000;
        const source = new FakeSource();
        source.next("openai", updated([remoteModel]));
        source.next("openai", { kind: "not-modified" });
        const catalog = createCatalog({ source, now: () => currentTime });

        await catalog.refreshProvider("openai", { force: true });
        currentTime += ModelCatalogFreshMs - 1;
        await catalog.refreshProvider("openai");
        await catalog.refreshProvider("openai", { force: true });

        expect(source.callsFor("openai")).toBe(2);
    });

    it("rejects remote overlays older than the generated baseline", async () => {
        const source = new FakeSource();
        source.next("openai", updated([replacementModel], { lastModified: 999 }));
        const catalog = createCatalog({ source, generatedAt: 1_000 });

        await catalog.refreshProvider("openai", { force: true });

        expect(catalog.getModels("openai")).toEqual([baselineModel]);
    });

    it("does not emit a revision for 304 or identical model content", async () => {
        const source = new FakeSource();
        const catalog = createCatalog({ source });
        const listener = vi.fn();
        catalog.subscribe(listener);
        source.next("openai", { kind: "not-modified" });
        source.next("openai", updated([baselineModel]));

        await catalog.refreshProvider("openai", { force: true });
        await catalog.refreshProvider("openai", { force: true });

        expect(listener).not.toHaveBeenCalled();
        expect(catalog.getRevision()).toBe(0);
    });

    it("preserves the last good models after source errors", async () => {
        const source = new FakeSource();
        source.next("openai", updated([remoteModel]));
        source.next("openai", new Error("offline"));
        const catalog = createCatalog({ source });
        await catalog.refreshProvider("openai", { force: true });

        await expect(catalog.refreshProvider("openai", { force: true })).rejects.toThrow("offline");

        expect(catalog.getModels("openai")).toEqual([baselineModel, remoteModel]);
    });

    it("falls back to the baseline when the source reports the provider unavailable", async () => {
        const source = new FakeSource();
        source.next("openai", updated([remoteModel]));
        source.next("openai", { kind: "unavailable" });
        const catalog = createCatalog({ source });
        await catalog.refreshProvider("openai", { force: true });

        await catalog.refreshProvider("openai", { force: true });

        expect(catalog.getModels("openai")).toEqual([baselineModel]);
    });

    it("gates retries exponentially after failures", async () => {
        let currentTime = 1_000;
        const source = new FakeSource();
        source.next("openai", new Error("offline once"));
        source.next("openai", new Error("offline twice"));
        source.next("openai", updated([remoteModel]));
        const catalog = createCatalog({ source, now: () => currentTime });

        await expect(catalog.refreshProvider("openai")).rejects.toThrow("offline once");
        currentTime += 59_999;
        await catalog.refreshProvider("openai");
        expect(source.callsFor("openai")).toBe(1);
        currentTime += 1;
        await expect(catalog.refreshProvider("openai")).rejects.toThrow("offline twice");
        currentTime += 119_999;
        await catalog.refreshProvider("openai");
        expect(source.callsFor("openai")).toBe(2);
        currentTime += 1;
        await catalog.refreshProvider("openai");

        expect(source.callsFor("openai")).toBe(3);
        expect(catalog.getModel("openai", remoteModel.id)).toEqual(remoteModel);
    });

    it("refreshes only active providers", async () => {
        const source = new FakeSource();
        source.next("openai", { kind: "not-modified" });
        const catalog = createCatalog({ source });
        catalog.activateProvider("openai");

        await catalog.refreshActive({ force: true });

        expect(source.callsFor("openai")).toBe(1);
        expect(source.callsFor("anthropic")).toBe(0);
    });

    it("starts and stops the hourly scheduler", async () => {
        const source = new FakeSource();
        source.next("openai", { kind: "not-modified" });
        const timer = { unref: vi.fn() };
        let scheduled: (() => void) | undefined;
        const setInterval = vi.fn((callback: () => void, interval: number) => {
            scheduled = callback;
            expect(interval).toBe(ModelCatalogRefreshIntervalMs);
            return timer;
        });
        const clearInterval = vi.fn();
        const catalog = createCatalog({ source, setInterval, clearInterval });
        catalog.activateProvider("openai");

        catalog.start();
        scheduled?.();
        await vi.waitFor(() => expect(source.callsFor("openai")).toBe(1));
        catalog.stop();

        expect(setInterval).toHaveBeenCalledOnce();
        expect(timer.unref).toHaveBeenCalledOnce();
        expect(clearInterval).toHaveBeenCalledWith(timer);
    });

    it("aborts in-flight provider requests when stopped", async () => {
        const source: ModelCatalogSource = {
            fetchProvider: vi.fn(({ signal }) => {
                return new Promise<ModelCatalogSourceResult>((_resolve, reject) => {
                    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
                });
            }),
        };
        const catalog = createCatalog({ source });

        const refresh = catalog.refreshProvider("openai", { force: true });
        await vi.waitFor(() => expect(source.fetchProvider).toHaveBeenCalledOnce());
        catalog.stop();

        await expect(refresh).rejects.toThrow();
    });
});

function model(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
    return {
        id,
        name: id,
        api: "openai-responses",
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
        ...overrides,
    };
}

function providerState(
    models: Model<Api>[],
    overrides: Partial<ModelCatalogProviderCache> = {}
): ModelCatalogProviderCache {
    return { models, failureCount: 0, ...overrides };
}

function updated(
    models: Model<Api>[],
    metadata: Omit<Extract<ModelCatalogSourceResult, { kind: "updated" }>, "kind" | "models"> = {}
): ModelCatalogSourceResult {
    return { kind: "updated", models, ...metadata };
}

class MemoryStore implements ModelCatalogStore {
    private cache: ModelCatalogCache | undefined;

    constructor(cache?: ModelCatalogCache) {
        this.cache = cache ? structuredClone(cache) : undefined;
    }

    async read(): Promise<ModelCatalogCache | undefined> {
        return this.cache ? structuredClone(this.cache) : undefined;
    }

    async writeProvider(providerId: string, state: ModelCatalogProviderCache): Promise<void> {
        this.cache ??= { schemaVersion: ModelCatalogCacheSchemaVersion, providers: {} };
        this.cache.providers[providerId] = structuredClone(state);
    }

    async withRefreshLock<T>(_providerId: string, run: () => Promise<T>): Promise<T> {
        return run();
    }
}

class FakeSource implements ModelCatalogSource {
    private readonly responses = new Map<
        string,
        Array<ModelCatalogSourceResult | Error | Promise<ModelCatalogSourceResult>>
    >();
    private readonly calls = new Map<string, number>();

    next(providerId: string, response: ModelCatalogSourceResult | Error | Promise<ModelCatalogSourceResult>): void {
        const queue = this.responses.get(providerId) ?? [];
        queue.push(response);
        this.responses.set(providerId, queue);
    }

    callsFor(providerId: string): number {
        return this.calls.get(providerId) ?? 0;
    }

    async fetchProvider({ providerId }: { providerId: string }): Promise<ModelCatalogSourceResult> {
        this.calls.set(providerId, this.callsFor(providerId) + 1);
        const response = this.responses.get(providerId)?.shift();
        if (!response) throw new Error(`no response queued for ${providerId}`);
        if (response instanceof Error) throw response;
        return response;
    }
}

function createCatalog(
    overrides: {
        source?: ModelCatalogSource;
        store?: ModelCatalogStore;
        generatedAt?: number;
        now?: () => number;
        setInterval?: (callback: () => void, interval: number) => unknown;
        clearInterval?: (timer: unknown) => void;
    } = {}
) {
    return createModelCatalogService({
        baseline: [baselineModel],
        generatedAt: overrides.generatedAt,
        source: overrides.source ?? new FakeSource(),
        store: overrides.store ?? new MemoryStore(),
        now: overrides.now,
        setInterval: overrides.setInterval,
        clearInterval: overrides.clearInterval,
    });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
