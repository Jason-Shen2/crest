// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModelCatalogCacheSchemaVersion, type ModelCatalogProviderCache } from "@crest/ai/model-catalog";

import { FileModelCatalogStore } from "./model-catalog-store";

describe("FileModelCatalogStore", () => {
    let directory: string;
    let cachePath: string;

    beforeEach(async () => {
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "crest-model-catalog-store-"));
        cachePath = path.join(directory, "model-catalog.json");
    });

    afterEach(async () => {
        await fs.rm(directory, { recursive: true, force: true });
    });

    it("returns undefined when the cache file is missing", async () => {
        const store = new FileModelCatalogStore(cachePath);

        await expect(store.read()).resolves.toBeUndefined();
    });

    it("writes and reads a valid provider record", async () => {
        const store = new FileModelCatalogStore(cachePath);
        const state = providerState("gpt-next");

        await store.writeProvider("openai", state);

        await expect(store.read()).resolves.toEqual({
            schemaVersion: ModelCatalogCacheSchemaVersion,
            providers: { openai: state },
        });
    });

    it.each([
        ["unknown schema", JSON.stringify({ schemaVersion: 99, providers: {} })],
        ["malformed JSON", "{not-json"],
        ["invalid document", JSON.stringify({ schemaVersion: ModelCatalogCacheSchemaVersion, providers: [] })],
    ])("ignores %s", async (_name, contents) => {
        await fs.writeFile(cachePath, contents, "utf8");
        const store = new FileModelCatalogStore(cachePath);

        await expect(store.read()).resolves.toBeUndefined();
    });

    it("preserves providers written by concurrent store instances", async () => {
        const first = new FileModelCatalogStore(cachePath);
        const second = new FileModelCatalogStore(cachePath);

        await Promise.all([
            first.writeProvider("openai", providerState("gpt-next")),
            second.writeProvider("anthropic", providerState("claude-next", "anthropic")),
        ]);

        await expect(first.read()).resolves.toMatchObject({
            providers: { openai: {}, anthropic: {} },
        });
    });

    it("recovers a write lock older than two minutes", async () => {
        const lockPath = `${cachePath}.write.lock`;
        await fs.writeFile(lockPath, "stale", "utf8");
        const staleTime = new Date(Date.now() - 121_000);
        await fs.utimes(lockPath, staleTime, staleTime);
        const store = new FileModelCatalogStore(cachePath);

        await store.writeProvider("openai", providerState("gpt-next"));

        await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(store.read()).resolves.toMatchObject({ providers: { openai: {} } });
    });

    it("writes a same-directory temporary file before atomic rename", async () => {
        const rename = vi.fn((source: string, target: string) => fs.rename(source, target));
        const store = new FileModelCatalogStore(cachePath, { rename, uniqueSuffix: () => "fixed" });

        await store.writeProvider("openai", providerState("gpt-next"));

        expect(rename).toHaveBeenCalledOnce();
        const [temporaryPath, targetPath] = rename.mock.calls[0];
        expect(path.dirname(temporaryPath)).toBe(directory);
        expect(path.basename(temporaryPath)).toBe(`model-catalog.json.tmp-${process.pid}-fixed`);
        expect(targetPath).toBe(cachePath);
        expect(await fs.readdir(directory)).toEqual(["model-catalog.json"]);
    });

    it("cleans up the exact temporary file when rename fails", async () => {
        const rename = vi.fn().mockRejectedValue(new Error("rename failed"));
        const store = new FileModelCatalogStore(cachePath, { rename, uniqueSuffix: () => "failed" });

        await expect(store.writeProvider("openai", providerState("gpt-next"))).rejects.toThrow("rename failed");

        expect(await fs.readdir(directory)).toEqual([]);
    });

    it("serializes same-provider refreshes without blocking other providers", async () => {
        const first = new FileModelCatalogStore(cachePath);
        const second = new FileModelCatalogStore(cachePath);
        const openAiStarted = deferred<void>();
        const releaseOpenAi = deferred<void>();
        const calls: string[] = [];

        const firstOpenAi = first.withRefreshLock("openai", async () => {
            calls.push("openai:first:start");
            openAiStarted.resolve();
            await releaseOpenAi.promise;
            calls.push("openai:first:end");
        });
        await openAiStarted.promise;
        const secondOpenAi = second.withRefreshLock("openai", async () => {
            calls.push("openai:second");
        });
        await second.withRefreshLock("anthropic", async () => {
            calls.push("anthropic");
        });
        expect(calls).toEqual(["openai:first:start", "anthropic"]);

        releaseOpenAi.resolve();
        await Promise.all([firstOpenAi, secondOpenAi]);

        expect(calls).toEqual(["openai:first:start", "anthropic", "openai:first:end", "openai:second"]);
    });
});

function providerState(modelId: string, provider = "openai"): ModelCatalogProviderCache {
    return {
        models: [
            {
                id: modelId,
                name: modelId,
                api: "openai-responses",
                provider,
                baseUrl: "https://example.com/v1",
                reasoning: true,
                input: ["text"],
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 16_384,
            },
        ],
        lastSuccessAt: 1_000,
        failureCount: 0,
    };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
