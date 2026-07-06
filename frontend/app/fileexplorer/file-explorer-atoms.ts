// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms, getApi, getOrefMetaKeyAtom } from "@/store/global";
import * as WOS from "@/store/wos";
import * as jotai from "jotai";

// Snapshot the user's home dir once; getApi().getHomeDir() is synchronous IPC
// that returns the same value for the life of the process (same pattern used in
// vtabbar.tsx:172 and termblocks.tsx:68).
const CachedHome: string = getApi().getHomeDir() ?? "~";

export function getCachedHome(): string {
    return CachedHome;
}

// SSoT for the project directory. Every Space is bound to one directory at
// creation (workspace:dir, immutable). File explorer / git / command palette /
// agent all anchor here rather than following the focused terminal's cwd.
export const workspaceDirAtom: jotai.Atom<string> = jotai.atom((get) => {
    const wsId = get(atoms.workspace)?.oid;
    if (!wsId) return CachedHome;
    const dir = get(getOrefMetaKeyAtom(WOS.makeORef("workspace", wsId), "workspace:dir")) as
        | string
        | undefined;
    return dir || CachedHome;
});
