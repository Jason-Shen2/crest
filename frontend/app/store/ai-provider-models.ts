// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Per-provider live model list — fetched on demand from the provider's
// /models endpoint via the listprovidermodels wshrpc, then cached in a
// session-scoped jotai atom map. The picker mounts this; the wizard
// has its own preview path that hits the same RPC directly.
//
// Cache is in-memory only — restarting the app re-fetches. A per-provider
// refresh helper bypasses the cache. Errors surface verbatim so the user
// can fix a bad key / endpoint without leaving the picker.

import { atom } from "jotai";

import { CATALOG, findProvider, resolveEndpoint } from "@/app/store/ai-catalog";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";

import type { UserConfig } from "./ai-types";

export type ProviderModelsStatus = "idle" | "loading" | "ok" | "error";

export interface ProviderModelInfoLite {
    id: string;
    name?: string;
    description?: string;
    context?: number;
    maxoutputtokens?: number;
    promptcost?: number;
    completioncost?: number;
    imagecost?: number;
    requestcost?: number;
    inputmodalities?: string[];
    tokenizer?: string;
    ismoderated?: boolean;
}

export interface ProviderModelsState {
    status: ProviderModelsStatus;
    models: ProviderModelInfoLite[];
    error?: string;
    // ms-since-epoch of the last successful fetch; null when never fetched.
    fetchedAt: number | null;
}

const EMPTY_STATE: ProviderModelsState = { status: "idle", models: [], fetchedAt: null };

// Single atom holding the full provider→state map; consumers select the
// slice they care about via providerModelsAtomFor(providerId). One atom
// keeps cross-provider updates atomic and avoids the "atom families
// don't dedupe" footgun.
export const providerModelsMapAtom = atom<Record<string, ProviderModelsState>>({});

// Per-provider read selector. Components subscribe via useAtomValue and
// only re-render when *their* provider's slice changes (jotai's default
// equality on the returned object value is fine because we always
// return the same identity until the map slot itself changes).
export function providerModelsAtomFor(providerId: string) {
    return atom((get) => {
        const map = get(providerModelsMapAtom);
        return map[providerId] ?? EMPTY_STATE;
    });
}

// In-flight promise map so concurrent callers (picker mount + tab
// activate firing at the same time) share a single network call.
const inflight = new Map<string, Promise<void>>();

interface FetchInputs {
    apitype: string;
    baseurl?: string;
    apitoken?: string;
    tokensecretname?: string;
    // Optional override for the /models endpoint. When set, the IPC
    // uses this URL instead of deriving one from baseurl (which is the
    // chat URL). See ProviderEntry.modelsEndpoint in ai-catalog.ts.
    modelsendpoint?: string;
}

// Resolve the (apitype, baseurl, tokensecretname) the listprovidermodels
// RPC needs from catalog + saved user config. Returns null when the
// provider isn't known and isn't a custom endpoint either — caller treats
// that as "no live fetch available".
function resolveFetchInputs(
    providerId: string,
    userConfig: UserConfig | null
): FetchInputs | null {
    const creds = userConfig?.providers?.[providerId];
    const catalogProvider = findProvider(providerId);
    if (catalogProvider) {
        return {
            apitype: catalogProvider.defaultApiType,
            // Use the bare endpoint with the {model} placeholder intact —
            // the Go side's modelsURLFromChatURL strips the operation
            // suffix and appends /models, and Gemini's geminiModelsURL
            // chops at /models so the placeholder never matters.
            baseurl: catalogProvider.defaultEndpoint,
            tokensecretname: creds?.tokensecretname ?? catalogProvider.tokenSecretName,
            apitoken: creds?.token,
            modelsendpoint: catalogProvider.modelsEndpoint,
        };
    }
    const custom = userConfig?.custom_endpoints?.[providerId];
    if (custom) {
        return {
            apitype: custom.apitype,
            baseurl: custom.endpoint,
            tokensecretname: custom.tokensecretname || undefined,
        };
    }
    return null;
}

function setSlice(providerId: string, next: ProviderModelsState) {
    const cur = globalStore.get(providerModelsMapAtom);
    globalStore.set(providerModelsMapAtom, { ...cur, [providerId]: next });
}

// fetchProviderModels — lazy fetch. No-op when the slice is already
// loading or has a successful result (use refreshProviderModels for
// explicit refresh). Errors are cached in the slice so the picker can
// render them inline; the next refresh clears them.
export function fetchProviderModels(
    providerId: string,
    userConfig: UserConfig | null
): Promise<void> {
    const cur = globalStore.get(providerModelsMapAtom)[providerId];
    if (cur?.status === "ok") return Promise.resolve();
    if (cur?.status === "loading") return inflight.get(providerId) ?? Promise.resolve();
    return runFetch(providerId, userConfig);
}

export function refreshProviderModels(
    providerId: string,
    userConfig: UserConfig | null
): Promise<void> {
    return runFetch(providerId, userConfig);
}

function runFetch(providerId: string, userConfig: UserConfig | null): Promise<void> {
    const inputs = resolveFetchInputs(providerId, userConfig);
    if (!inputs) {
        setSlice(providerId, {
            status: "error",
            models: [],
            error: `Unknown provider "${providerId}" — no catalog entry or custom endpoint matches.`,
            fetchedAt: null,
        });
        return Promise.resolve();
    }
    setSlice(providerId, {
        status: "loading",
        models: globalStore.get(providerModelsMapAtom)[providerId]?.models ?? [],
        fetchedAt: globalStore.get(providerModelsMapAtom)[providerId]?.fetchedAt ?? null,
    });
    const p = (async () => {
        try {
            const models = await getApi().ai.listProviderModels({
                apitype: inputs.apitype,
                baseurl: inputs.baseurl,
                apitoken: inputs.apitoken,
                tokensecretname: inputs.tokensecretname,
                modelsendpoint: inputs.modelsendpoint,
            });
            setSlice(providerId, {
                status: "ok",
                models: models ?? [],
                fetchedAt: Date.now(),
            });
        } catch (e) {
            setSlice(providerId, {
                status: "error",
                models: globalStore.get(providerModelsMapAtom)[providerId]?.models ?? [],
                error: e instanceof Error ? e.message : String(e),
                fetchedAt: globalStore.get(providerModelsMapAtom)[providerId]?.fetchedAt ?? null,
            });
        } finally {
            inflight.delete(providerId);
        }
    })();
    inflight.set(providerId, p);
    return p;
}

// providersWithCredentials — list of provider ids the user has
// credentials saved for. Order: catalog declaration order first,
// then custom_endpoints insertion order.
export function providersWithCredentials(userConfig: UserConfig | null): string[] {
    if (!userConfig?.providers) return [];
    const out: string[] = [];
    for (const p of CATALOG) {
        if (userConfig.providers[p.id]) out.push(p.id);
    }
    for (const id of Object.keys(userConfig.custom_endpoints ?? {})) {
        if (userConfig.providers[id]) out.push(id);
    }
    return out;
}

// providerDisplayName — small lookup used by the picker for tab labels.
// Falls back to the id when nothing matches (which shouldn't happen for
// configured providers, but keeps the UI from crashing on stale data).
export function providerDisplayName(
    providerId: string,
    userConfig: UserConfig | null
): string {
    const cat = findProvider(providerId);
    if (cat) return cat.displayName;
    const custom = userConfig?.custom_endpoints?.[providerId];
    if (custom) return custom.displayname;
    return providerId;
}

// providerIcon — same fallback chain as displayName.
export function providerIcon(providerId: string, userConfig: UserConfig | null): string {
    const cat = findProvider(providerId);
    if (cat) return cat.icon;
    const custom = userConfig?.custom_endpoints?.[providerId];
    if (custom?.icon) return custom.icon;
    return "code-02";
}

// Re-export resolveEndpoint to keep the picker file free of catalog
// internals; the picker doesn't actually use it today but having it
// here means future "show endpoint" tooltips can stay self-contained.
export { resolveEndpoint };
