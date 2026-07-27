// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Pure-Node file enumeration for the find + grep tools. pi's find/grep
// shell out to fd/ripgrep (downloading the binaries if missing); crest
// deliberately does NOT download binaries, so we enumerate with the
// `glob` package and apply .gitignore via the `ignore` package instead.
//
// Tradeoff vs fd/rg: slower on very large trees and only the repo-root
// .gitignore is honored (not nested per-directory .gitignore files).
// node_modules / .git are always skipped. Good enough for the common
// "search this project" case; revisit if it proves too slow.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { glob } from "glob";
import ignore, { type Ignore } from "ignore";

// Globs passed to `glob`'s ignore option so it never descends into these
// (keeps node_modules off the walk for speed, not just off the results).
const DEFAULT_IGNORE_GLOBS = ["**/node_modules/**", "**/.git/**"];

/** Build an Ignore from always-skip dirs + the repo-root .gitignore. */
export async function buildGitignore(cwd: string): Promise<Ignore> {
    const ig = ignore().add(["node_modules", ".git"]);
    try {
        const gitignore = await fs.readFile(path.join(cwd, ".gitignore"), "utf8");
        ig.add(gitignore);
    } catch {
        // no .gitignore — defaults still apply
    }
    return ig;
}

function toPosix(p: string): string {
    return p.split(path.sep).join("/");
}

/**
 * Enumerate files under `cwd` matching a glob `pattern`, honoring
 * .gitignore. Returns POSIX-relative paths, sorted, capped at `limit`.
 * Stops early once the cap is hit. `reachedLimit` reports whether more
 * matches existed.
 */
export async function enumerateFiles(
    pattern: string,
    cwd: string,
    opts: { limit: number; signal?: AbortSignal },
): Promise<{ files: string[]; reachedLimit: boolean }> {
    const matches = await glob(pattern, {
        cwd,
        nodir: true,
        dot: true,
        follow: false,
        ignore: DEFAULT_IGNORE_GLOBS,
        signal: opts.signal,
    });
    const ig = await buildGitignore(cwd);
    const kept: string[] = [];
    let reachedLimit = false;
    for (const m of matches.sort()) {
        if (opts.signal?.aborted) throw new Error("Operation aborted");
        const rel = toPosix(m);
        if (ig.ignores(rel)) continue;
        if (kept.length >= opts.limit) {
            reachedLimit = true;
            break;
        }
        kept.push(rel);
    }
    return { files: kept, reachedLimit };
}
