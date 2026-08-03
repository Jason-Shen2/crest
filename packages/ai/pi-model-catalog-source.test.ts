// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createPiModelCatalogSource } from "./pi-model-catalog-source";
import type { Api, Model } from "./types";

const remoteModel = model("gpt-next", { provider: "wrong-provider" });

describe("PiModelCatalogSource", () => {
    it("requests the provider catalog with its validator and response metadata", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse([remoteModel], {
                etag: '"v2"',
                "last-modified": "Sun, 02 Aug 2026 12:00:00 GMT",
            })
        );
        const source = createPiModelCatalogSource({ fetch: fetchMock });

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
        expect(result).toEqual({
            kind: "updated",
            models: [{ ...remoteModel, provider: "openai" }],
            etag: '"v2"',
            lastModified: Date.parse("Sun, 02 Aug 2026 12:00:00 GMT"),
        });
    });

    it.each([
        ["array", [remoteModel]],
        ["models envelope", { models: [remoteModel] }],
        ["object map", { models: { "gpt-next": { ...remoteModel, id: undefined } } }],
    ])("accepts the %s response shape", async (_name, body) => {
        const source = createPiModelCatalogSource({ fetch: vi.fn().mockResolvedValue(jsonResponse(body)) });

        const result = await source.fetchProvider(request("openai"));

        expect(result).toMatchObject({ kind: "updated", models: [{ id: "gpt-next", provider: "openai" }] });
    });

    it("returns not-modified for 304 and unavailable for 404 or 501", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"v2"' } }))
            .mockResolvedValueOnce(new Response(null, { status: 404 }))
            .mockResolvedValueOnce(new Response(null, { status: 501 }));
        const source = createPiModelCatalogSource({ fetch: fetchMock });

        await expect(source.fetchProvider(request("openai"))).resolves.toEqual({
            kind: "not-modified",
            etag: '"v2"',
            lastModified: undefined,
        });
        await expect(source.fetchProvider(request("openai"))).resolves.toEqual({ kind: "unavailable" });
        await expect(source.fetchProvider(request("openai"))).resolves.toEqual({ kind: "unavailable" });
    });

    it("rejects the entire response when one model is malformed without retrying", async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse([remoteModel, { id: "broken" }]));
        const sleep = vi.fn();
        const source = createPiModelCatalogSource({ fetch: fetchMock, sleep });

        await expect(source.fetchProvider(request("openai"))).rejects.toThrow("invalid model");

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(sleep).not.toHaveBeenCalled();
    });

    it("aborts an attempt after the configured timeout", async () => {
        const fetchMock = vi.fn((_url: string, init: RequestInit) => {
            return new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), {
                    once: true,
                });
            });
        });
        const source = createPiModelCatalogSource({ fetch: fetchMock, timeoutMs: 5, maxRetries: 0 });

        await expect(source.fetchProvider(request("openai"))).rejects.toThrow("timed out after 5ms");
    });

    it("retries two transient responses with exponential delay and bounded jitter", async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(new Response("busy", { status: 500 }))
            .mockResolvedValueOnce(new Response("limited", { status: 429 }))
            .mockResolvedValueOnce(jsonResponse([remoteModel]));
        const sleep = vi.fn().mockResolvedValue(undefined);
        const source = createPiModelCatalogSource({ fetch: fetchMock, sleep, random: () => 0 });

        await expect(source.fetchProvider(request("openai"))).resolves.toMatchObject({ kind: "updated" });

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenNthCalledWith(1, 1_000, expect.any(AbortSignal));
        expect(sleep).toHaveBeenNthCalledWith(2, 2_000, expect.any(AbortSignal));
    });

    it("retries network errors but not other 4xx responses", async () => {
        const fetchMock = vi
            .fn()
            .mockRejectedValueOnce(new TypeError("fetch failed"))
            .mockResolvedValueOnce(jsonResponse([remoteModel]))
            .mockResolvedValueOnce(new Response("bad request", { status: 400 }));
        const sleep = vi.fn().mockResolvedValue(undefined);
        const source = createPiModelCatalogSource({ fetch: fetchMock, sleep, random: () => 0 });

        await expect(source.fetchProvider(request("openai"))).resolves.toMatchObject({ kind: "updated" });
        await expect(source.fetchProvider(request("openai"))).rejects.toThrow("400");

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(sleep).toHaveBeenCalledOnce();
    });

    it("links caller cancellation to the active request", async () => {
        const fetchMock = vi.fn((_url: string, init: RequestInit) => {
            return new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
            });
        });
        const source = createPiModelCatalogSource({ fetch: fetchMock });
        const controller = new AbortController();

        const result = source.fetchProvider(request("openai", controller.signal));
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
        controller.abort(new Error("cancelled"));

        await expect(result).rejects.toThrow("cancelled");
        expect(fetchMock).toHaveBeenCalledOnce();
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

function jsonResponse(body: unknown, headers?: HeadersInit): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
    });
}

function request(providerId: string, signal = new AbortController().signal) {
    return { providerId, signal };
}
