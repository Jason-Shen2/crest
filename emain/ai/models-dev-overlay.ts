// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// models.dev capability overlay.
//
// Why this exists: direct providers (Anthropic / OpenAI / Gemini / ...)
// expose their capability facts (reasoning, input modalities, price,
// context) only through the static models.generated.ts snapshot baked
// into the app at build time. That snapshot goes stale and — in this
// repo — can't even be regenerated (no generator script ships here). So
// a user who doesn't update the app is stuck with frozen capability
// metadata.
//
// This module keeps that metadata fresh *without* touching the
// request-building registry (emain/ai/models.ts stays fully sync and
// authoritative for api / baseUrl / thinkingLevelMap — fields models.dev
// doesn't carry). It only feeds the picker's capability-display path
// (listRegistryModels): on startup it fetches models.dev/api.json in the
// background, caches it to disk with a TTL, and exposes a *synchronous*
// per-(provider, model) lookup that listRegistryModels overlays on top
// of the static snapshot. Network/parse failures degrade silently to the
// on-disk cache, then to the static snapshot — never blocking startup.

import fs from "fs";
import path from "path";

import { getWaveDataDir } from "../emain-platform";

const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_FILE_NAME = "models-dev-cache.json";
// Capability metadata for direct (slow-moving) providers changes rarely;
// a day-long TTL keeps the once-per-launch fetch from hammering the API
// on every restart while still picking up changes within a day of use.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

// The subset of a models.dev model entry we actually surface to the
// picker. Mirrors the fields RegistryModelInfo carries. All optional —
// an absent field means "models.dev didn't say", so the static snapshot
// value is kept rather than overwritten.
export interface ModelCapabilityOverlay {
    reasoning?: boolean;
    inputmodalities?: string[];
    context?: number;
    maxoutputtokens?: number;
    promptcost?: number;
    completioncost?: number;
}

// provider -> modelId -> overlay
type OverlayMap = Record<string, Record<string, ModelCapabilityOverlay>>;

interface CacheFile {
    fetchedAt: number;
    data: OverlayMap;
}

// Shape of a models.dev model entry (only the fields we read). See
// https://models.dev/api.json.
interface ModelsDevModel {
    reasoning?: boolean;
    modalities?: { input?: string[]; output?: string[] };
    limit?: { context?: number; output?: number };
    cost?: { input?: number; output?: number };
}

interface ModelsDevProvider {
    models?: Record<string, ModelsDevModel>;
}

// In-memory overlay, populated from disk cache and/or a fresh fetch.
// Sync readers (listRegistryModels) see whatever is loaded so far;
// before the first load it's empty and callers fall back to the static
// snapshot — exactly the pre-overlay behavior.
let overlay: OverlayMap = {};

function cacheFilePath(): string {
    return path.join(getWaveDataDir(), CACHE_FILE_NAME);
}

// Synchronous lookup used by listRegistryModels. Returns undefined when
// models.dev has nothing for this (provider, model) — caller keeps the
// static snapshot value.
export function getCapabilityOverlay(provider: string, modelId: string): ModelCapabilityOverlay | undefined {
    return overlay[provider]?.[modelId];
}

// Flatten the raw models.dev api.json into our compact overlay map,
// keeping only the capability fields we display. models.dev's top-level
// keys are provider ids (anthropic, google, openai, ...) matching the
// registry's provider keys, so no remapping is needed.
function buildOverlay(raw: Record<string, ModelsDevProvider>): OverlayMap {
    const out: OverlayMap = {};
    for (const [provider, providerData] of Object.entries(raw)) {
        const models = providerData?.models;
        if (!models) continue;
        const providerOut: Record<string, ModelCapabilityOverlay> = {};
        for (const [modelId, m] of Object.entries(models)) {
            const entry: ModelCapabilityOverlay = {};
            if (typeof m.reasoning === "boolean") entry.reasoning = m.reasoning;
            if (m.modalities?.input) entry.inputmodalities = m.modalities.input;
            if (typeof m.limit?.context === "number") entry.context = m.limit.context;
            if (typeof m.limit?.output === "number") entry.maxoutputtokens = m.limit.output;
            if (typeof m.cost?.input === "number") entry.promptcost = m.cost.input;
            if (typeof m.cost?.output === "number") entry.completioncost = m.cost.output;
            if (Object.keys(entry).length > 0) providerOut[modelId] = entry;
        }
        if (Object.keys(providerOut).length > 0) out[provider] = providerOut;
    }
    return out;
}

function readCache(): CacheFile | null {
    try {
        const raw = fs.readFileSync(cacheFilePath(), "utf8");
        const parsed = JSON.parse(raw) as CacheFile;
        if (parsed && typeof parsed.fetchedAt === "number" && parsed.data) return parsed;
        return null;
    } catch {
        return null;
    }
}

function writeCache(data: OverlayMap): void {
    try {
        const payload: CacheFile = { fetchedAt: Date.now(), data };
        fs.writeFileSync(cacheFilePath(), JSON.stringify(payload), "utf8");
    } catch (e) {
        console.log("models.dev overlay: failed to write cache", e);
    }
}

async function fetchModelsDev(): Promise<OverlayMap | null> {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let raw: Record<string, ModelsDevProvider>;
        try {
            const resp = await fetch(MODELS_DEV_URL, { signal: controller.signal });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            raw = (await resp.json()) as Record<string, ModelsDevProvider>;
        } finally {
            clearTimeout(timeout);
        }
        return buildOverlay(raw);
    } catch (e) {
        console.log("models.dev overlay: fetch failed", e);
        return null;
    }
}

// initModelsDevOverlay — startup entry point. Loads the on-disk cache
// immediately (so the overlay is populated even offline), then refreshes
// from the network in the background when the cache is missing or older
// than the TTL. Never throws; failures leave the overlay at whatever the
// cache provided (or empty → static-snapshot fallback). Fire-and-forget
// from appMain; does not block startup.
export async function initModelsDevOverlay(): Promise<void> {
    const cached = readCache();
    if (cached) {
        overlay = cached.data;
        if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) return; // fresh enough
    }
    const fresh = await fetchModelsDev();
    if (fresh) {
        overlay = fresh;
        writeCache(fresh);
    }
}
