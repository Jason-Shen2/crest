// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Frontend access layer for ~/.config/crest/ai.json.  Calls the
// getApi().ai.getUserConfig / writeUserConfig electron-main IPC
// handlers (see emain/aiconfig-ipc.ts) and exposes the result as a
// jotai atom so the picker and any other consumers see the same
// single load.
//
// State machine:
//
//   loading  →  ok        (file present, parsed, validated)
//            \  missing   (file does not exist — first run)
//            \  malformed (file present but parse / validate failed)
//            \  rpc_error (wshrpc itself failed — backend down)
//
// The "missing" branch is the empty-state path the picker renders a
// banner for (Phase D acceptance).  "malformed" surfaces the
// underlying parse error to the user so they can fix the file.

import { atom } from "jotai";
import { getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";

import type { AIUserConfig, UserConfig } from "./ai-types";

export type AIUserConfigStatus = "loading" | "ok" | "missing" | "malformed" | "rpc_error";

export interface AIUserConfigState {
    status: AIUserConfigStatus;
    config: UserConfig | null;
    // Populated when status == "malformed" or "rpc_error".  Plain
    // string, ready for direct display in a banner.
    error?: string;
}

// Primitive atom — components read via `useAtomValue`, the loader
// writes via `globalStore.set`.  Initial state is "loading" so a
// component that mounts before the loader has fired renders a
// loading spinner rather than incorrectly showing the empty state.
export const aiUserConfigAtom = atom<AIUserConfigState>({
    status: "loading",
    config: null,
});

// reloadAIUserConfig — re-fetch from the backend.  Always overwrites
// the atom; the in-flight loader-tracking dance isn't needed because
// the picker doesn't surface a refresh button and the only callers
// are: app boot, post-write, and the picker mount.  Concurrent calls
// just race to the same answer; last write wins (and it's the same
// answer).
export async function reloadAIUserConfig(): Promise<void> {
    try {
        const resp = await getApi().ai.getUserConfig();
        switch (resp.status) {
            case "ok":
                globalStore.set(aiUserConfigAtom, {
                    status: "ok",
                    config: (resp.config ?? null) as UserConfig | null,
                });
                return;
            case "missing":
                globalStore.set(aiUserConfigAtom, { status: "missing", config: null });
                return;
            case "malformed":
                globalStore.set(aiUserConfigAtom, {
                    status: "malformed",
                    config: null,
                    error: resp.error,
                });
                return;
            default:
                // Backend added a new status we don't know about — treat
                // as rpc_error so the UI surfaces it instead of
                // pretending it's a happy path.
                globalStore.set(aiUserConfigAtom, {
                    status: "rpc_error",
                    config: null,
                    error: `unknown status "${(resp as { status: string }).status}" from ai.getUserConfig`,
                });
        }
    } catch (e) {
        globalStore.set(aiUserConfigAtom, {
            status: "rpc_error",
            config: null,
            error: e instanceof Error ? e.message : String(e),
        });
    }
}

// writeAIUserConfig — persist the config via electron IPC and refresh
// the atom on success.  Throws on validation / IO failure so the
// caller (a save button) can show the error inline; refresh fires
// afterwards so the picker sees the new state immediately.
export async function writeAIUserConfig(cfg: UserConfig): Promise<void> {
    await getApi().ai.writeUserConfig(cfg as AIUserConfig);
    await reloadAIUserConfig();
}

// initAIUserConfig — call once at app boot (e.g. from wave.ts) so the
// atom has a fresh state before any picker mounts.  Subsequent
// reloads go through reloadAIUserConfig.
export function initAIUserConfig(): void {
    void reloadAIUserConfig();
}

// isPinned — read-only helper for the picker; checks whether a
// (provider, model) pair appears in the current pinned[] list. Returns
// false when the config isn't loaded yet, which doubles as a sensible
// default while the picker is still hydrating.
export function isPinned(cfg: UserConfig | null, provider: string, model: string): boolean {
    if (!cfg?.pinned) return false;
    return cfg.pinned.some((p) => p.provider === provider && p.model === model);
}

// togglePinned — flips pinned membership for (provider, model) and
// persists the new ai.json. The atom is refreshed by writeAIUserConfig
// so consumers automatically see the new state on the next render.
// Throws on RPC/IO failure so the caller can surface the error.
export async function togglePinned(provider: string, model: string): Promise<void> {
    const state = globalStore.get(aiUserConfigAtom);
    if (state.status !== "ok" || !state.config) {
        throw new Error("ai.json not loaded — cannot toggle pin");
    }
    const cfg = state.config;
    const existing = cfg.pinned ?? [];
    const already = existing.some((p) => p.provider === provider && p.model === model);
    const nextPinned = already
        ? existing.filter((p) => !(p.provider === provider && p.model === model))
        : [...existing, { provider, model }];
    const next: UserConfig = { ...cfg, pinned: nextPinned };
    await writeAIUserConfig(next);
}
