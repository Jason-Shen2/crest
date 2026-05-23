// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as os from "node:os";
import * as path from "node:path";

/**
 * Expand a leading ~ or ~/ to the user's home dir. Crest tools accept
 * tilde-prefixed paths because they're natural for terminal users;
 * the agent's tool execution should mirror that.
 */
export function expandHome(p: string): string {
    if (p === "~") return os.homedir();
    if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
    return p;
}

/**
 * Resolve a path argument to absolute form, expanding ~ first. Throws
 * if the result is not absolute — tools require absolute inputs to
 * avoid ambiguity with the harness env's cwd (which is the pane cwd
 * at construction time, not at call time).
 */
export function requireAbsolute(p: string, toolName: string): string {
    const expanded = expandHome(p);
    if (!path.isAbsolute(expanded)) {
        throw new Error(`${toolName}: path must be absolute or ~-prefixed; got "${p}"`);
    }
    return expanded;
}
