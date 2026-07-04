// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { blockViewToName } from "@/app/block/blockutil";

// A tab is "auto-named" when it still wears the label the backend generated
// at creation time (the shell's start directory), rather than one the user
// (or openFile) chose. The backend marks such tabs with the tab:autoname
// meta flag; only those derive their label from block contents (terax's
// labelFor()). A user-set name clears the flag and always takes precedence.
export function isTabAutoNamed(tab: Tab | null | undefined): boolean {
    if (!tab) return false;
    if (tab.meta?.["tab:autoname"]) return true;
    // Legacy tabs created before tab:autoname existed still wear the old
    // "T<n>" placeholder — treat those as auto-named too.
    return isAutoTabName(tab.name);
}

// isAutoTabName — matches the legacy "T<number>" placeholder that older
// persisted tabs may still carry (see pkg/wcore's former getNextTabName).
export function isAutoTabName(name: string | undefined | null): boolean {
    return /^T\d+$/.test(name ?? "");
}

// basename — last path segment, tolerant of both "/" and "\" separators.
export function basename(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : path;
}

// deriveBlockDisplayName — the tab label derived from a single block,
// mirroring terax's per-tab labelFor():
//   - codeeditor / preview → the file's basename (its file name)
//   - term / termblocks    → the cwd's basename (its directory name)
//   - web                  → the URL
//   - anything else        → the human-readable view name
// Returns "" when there is no block/view/cwd resolved yet, letting callers
// fall back to the tab's persisted name instead of flashing a placeholder.
export function deriveBlockDisplayName(block: Block | null | undefined): string {
    const view = (block?.meta?.["view"] as string) || "";
    if (!view) return "";
    if (view === "codeeditor" || view === "preview") {
        const file = (block?.meta?.["file"] as string) || "";
        return file ? basename(file) : blockViewToName(view);
    }
    if (view === "term" || view === "termblocks") {
        const cwd = (block?.meta?.["cmd:cwd"] as string) || "";
        return cwd ? basename(cwd) : "";
    }
    if (view === "web") {
        return (block?.meta?.["url"] as string) || blockViewToName(view);
    }
    return blockViewToName(view);
}
