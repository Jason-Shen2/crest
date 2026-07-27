// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// resource-loader.ts — project context file loading (AGENTS.md /
// CLAUDE.md). Ported from pi's packages/coding-agent/src/core/
// resource-loader.ts (earendil-works/pi, MIT): only the
// loadContextFileFromDir + loadProjectContextFiles functions are
// carried over. pi's full ResourceLoader (extensions / themes /
// prompt-templates / package-manager) is out of scope for crest.
//
// Like pi, this runs at agent-session setup (not inside a tool), so it
// uses sync node:fs directly rather than the ExecutionEnv abstraction —
// matching pi's loader and the skills loader's setup-time role.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** A loaded project context file: its absolute path and full contents. */
export interface ProjectContextFile {
    path: string;
    content: string;
}

/**
 * Load the first AGENTS.md / CLAUDE.md (case variants) found in `dir`.
 * Returns null when none exists or all reads fail.
 */
function loadContextFileFromDir(dir: string): ProjectContextFile | null {
    const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
    for (const filename of candidates) {
        const filePath = join(dir, filename);
        if (existsSync(filePath)) {
            try {
                return { path: filePath, content: readFileSync(filePath, "utf-8") };
            } catch (error) {
                console.error(`Warning: Could not read ${filePath}: ${error}`);
            }
        }
    }
    return null;
}

/**
 * Load project context files for a pane: an optional global agent-dir
 * file first, then every AGENTS.md / CLAUDE.md from the filesystem root
 * down to cwd (root-most first, cwd last), deduped by absolute path.
 */
export function loadProjectContextFiles(options: {
    cwd: string;
    agentDir?: string;
}): ProjectContextFile[] {
    const resolvedCwd = resolve(options.cwd);

    const contextFiles: ProjectContextFile[] = [];
    const seenPaths = new Set<string>();

    if (options.agentDir) {
        const globalContext = loadContextFileFromDir(resolve(options.agentDir));
        if (globalContext) {
            contextFiles.push(globalContext);
            seenPaths.add(globalContext.path);
        }
    }

    const ancestorContextFiles: ProjectContextFile[] = [];

    let currentDir = resolvedCwd;
    const root = resolve("/");

    while (true) {
        const contextFile = loadContextFileFromDir(currentDir);
        if (contextFile && !seenPaths.has(contextFile.path)) {
            ancestorContextFiles.unshift(contextFile);
            seenPaths.add(contextFile.path);
        }

        if (currentDir === root) break;

        const parentDir = resolve(currentDir, "..");
        if (parentDir === currentDir) break;
        currentDir = parentDir;
    }

    contextFiles.push(...ancestorContextFiles);

    return contextFiles;
}
