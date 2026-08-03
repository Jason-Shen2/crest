// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ModelCatalogSource, ModelCatalogSourceResult } from "./model-catalog";
import type { Api, Model } from "./types";

const DefaultBaseUrl = "https://pi.dev";
const DefaultTimeoutMs = 10_000;
const DefaultMaxRetries = 2;
const RetryBaseMs = 1_000;
const RetryJitterRatio = 0.2;

export interface PiModelCatalogSourceOptions {
    baseUrl?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    maxRetries?: number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    random?: () => number;
    userAgent?: string;
}

export function createPiModelCatalogSource(options: PiModelCatalogSourceOptions = {}): ModelCatalogSource {
    const baseUrl = (options.baseUrl ?? DefaultBaseUrl).replace(/\/+$/, "");
    const fetchRequest = options.fetch ?? globalThis.fetch;
    const timeoutMs = options.timeoutMs ?? DefaultTimeoutMs;
    const maxRetries = options.maxRetries ?? DefaultMaxRetries;
    const sleep = options.sleep ?? abortableSleep;
    const random = options.random ?? Math.random;

    return {
        async fetchProvider({ providerId, etag, signal }): Promise<ModelCatalogSourceResult> {
            const normalizedProviderId = providerId.trim().toLowerCase();
            if (!normalizedProviderId) throw new Error("model catalog provider id is required");
            const url = `${baseUrl}/api/models/providers/${encodeURIComponent(normalizedProviderId)}`;

            for (let attempt = 0; ; attempt += 1) {
                throwIfAborted(signal);
                const attemptController = new AbortController();
                let timedOut = false;
                const onCallerAbort = () => attemptController.abort(signal.reason);
                signal.addEventListener("abort", onCallerAbort, { once: true });
                const timeout = setTimeout(() => {
                    timedOut = true;
                    attemptController.abort(new Error(`model catalog request timed out after ${timeoutMs}ms`));
                }, timeoutMs);

                try {
                    const headers: Record<string, string> = { accept: "application/json" };
                    if (etag) headers["if-none-match"] = etag;
                    if (options.userAgent) headers["user-agent"] = options.userAgent;
                    const response = await fetchRequest(url, {
                        method: "GET",
                        headers,
                        signal: attemptController.signal,
                    });
                    if (response.status === 304) {
                        return {
                            kind: "not-modified",
                            etag: response.headers.get("etag") ?? undefined,
                            lastModified: parseLastModified(response.headers.get("last-modified")),
                        };
                    }
                    if (response.status === 404 || response.status === 501) return { kind: "unavailable" };
                    if (isTransientStatus(response.status)) {
                        throw new RetryableHttpError(response.status, await response.text());
                    }
                    if (!response.ok) throw new Error(await formatHttpError(response));

                    const body = await response.json();
                    const models = parseModels(body, normalizedProviderId);
                    return {
                        kind: "updated",
                        models,
                        etag: response.headers.get("etag") ?? undefined,
                        lastModified: parseLastModified(response.headers.get("last-modified")),
                    };
                } catch (error) {
                    if (signal.aborted) throw abortReason(signal);
                    const failure = timedOut
                        ? new Error(`model catalog request timed out after ${timeoutMs}ms`)
                        : error;
                    if (attempt >= maxRetries || !isRetryableError(failure, timedOut)) throw failure;
                    const baseDelay = RetryBaseMs * 2 ** attempt;
                    const jitter = Math.floor(baseDelay * RetryJitterRatio * random());
                    await sleep(baseDelay + jitter, signal);
                } finally {
                    clearTimeout(timeout);
                    signal.removeEventListener("abort", onCallerAbort);
                }
            }
        },
    };
}

class RetryableHttpError extends Error {
    constructor(status: number, body: string) {
        const suffix = body ? `: ${body.slice(0, 500)}` : "";
        super(`model catalog request failed with ${status}${suffix}`);
    }
}

function parseModels(body: unknown, providerId: string): Model<Api>[] {
    const records = extractModelRecords(body);
    if (!records) throw new Error("model catalog response has an invalid model envelope");
    return records.map((record, index) => {
        if (!isModel(record)) throw new Error(`model catalog response contains invalid model at index ${index}`);
        return structuredClone({ ...record, provider: providerId });
    });
}

function extractModelRecords(body: unknown): unknown[] | undefined {
    if (Array.isArray(body)) return body;
    if (!isRecord(body)) return undefined;
    if ("models" in body) {
        if (Array.isArray(body.models)) return body.models;
        if (isRecord(body.models)) return modelMapValues(body.models);
        return undefined;
    }
    return modelMapValues(body);
}

function modelMapValues(models: Record<string, unknown>): unknown[] {
    return Object.entries(models).map(([id, value]) => {
        if (!isRecord(value)) return value;
        return { ...value, id: typeof value.id === "string" ? value.id : id };
    });
}

function isModel(value: unknown): value is Model<Api> {
    if (!isRecord(value)) return false;
    return (
        typeof value.id === "string" &&
        typeof value.name === "string" &&
        typeof value.api === "string" &&
        typeof value.provider === "string" &&
        typeof value.baseUrl === "string" &&
        typeof value.reasoning === "boolean" &&
        Array.isArray(value.input) &&
        value.input.every((input) => input === "text" || input === "image") &&
        isCost(value.cost) &&
        typeof value.contextWindow === "number" &&
        typeof value.maxTokens === "number"
    );
}

function isCost(value: unknown): boolean {
    if (!isRecord(value)) return false;
    return ["input", "output", "cacheRead", "cacheWrite"].every((key) => typeof value[key] === "number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseLastModified(value: string | null): number | undefined {
    if (!value) return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function isTransientStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(error: unknown, timedOut: boolean): boolean {
    return timedOut || error instanceof RetryableHttpError || error instanceof TypeError;
}

async function formatHttpError(response: Response): Promise<string> {
    const body = (await response.text()).slice(0, 500);
    return `model catalog request failed with ${response.status}${body ? `: ${body}` : ""}`;
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error ? signal.reason : new Error("model catalog request aborted");
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(abortReason(signal));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
    });
}
