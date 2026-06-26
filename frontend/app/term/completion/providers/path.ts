// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { CompletionContext, ParsedToken, Suggestion } from "../types";

function splitPath(token: string): { dirPart: string; namePrefix: string } {
    const idx = token.lastIndexOf("/");
    if (idx < 0) return { dirPart: "", namePrefix: token };
    return { dirPart: token.slice(0, idx + 1), namePrefix: token.slice(idx + 1) };
}

export async function pathProvider(ctx: CompletionContext, token: ParsedToken): Promise<Suggestion[]> {
    if (token.isFirstWord) return [];
    const { dirPart, namePrefix } = splitPath(token.text);
    const listTarget = dirPart === "" ? ctx.cwd : resolveDir(ctx.cwd, dirPart);
    let entries;
    try {
        entries = await ctx.listDir(listTarget);
    } catch {
        return [];
    }
    return entries
        .filter((e) => e.name.startsWith(namePrefix))
        .map((e) => {
            const replacement = dirPart + e.name + (e.isDir ? "/" : "");
            return {
                display: e.name + (e.isDir ? "/" : ""),
                replacement,
                type: "path" as const,
                priority: e.isDir ? 60 : 50,
                icon: e.isDir ? "folder" : "file",
            };
        });
}

function resolveDir(cwd: string, dirPart: string): string {
    if (dirPart.startsWith("/")) return dirPart;
    if (dirPart.startsWith("~")) return dirPart;
    const base = cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
    return base + "/" + dirPart.replace(/\/$/, "");
}
