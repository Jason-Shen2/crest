// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { isWindows } from "@/util/platformutil";

// Quote only when needed, so a clean path stays verbatim for bracketed paste
// (Claude resolves an image path to "[Image #N]"); spaced/special paths quote.
const SafePath = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

export function quoteShellPath(p: string): string {
    if (SafePath.test(p)) return p;
    if (isWindows()) return `"${p.replace(/"/g, '""')}"`;
    return `'${p.replace(/'/g, `'\\''`)}'`;
}

export function formatDroppedPaths(paths: string[]): string {
    return `${paths.map(quoteShellPath).join(" ")} `;
}
