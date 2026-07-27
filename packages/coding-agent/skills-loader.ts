// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// skills-loader.ts — discovers and loads agent skills at session setup.
// Wires crest's config-home + project-local skill directories into the
// full loadSkills() traversal that already lives in harness/skills.ts
// (ported from pi). Mirrors pi's ResourceLoader skill paths
// (packages/coding-agent/src/core/resource-loader.ts): a global dir
// under the agent/config home, plus a project-local dir under the
// repo's dot-config directory.
//
// pi uses <agentDir>/skills and <cwd>/.pi/skills. crest's equivalents
// are <configHome>/skills and <cwd>/.crest/skills.

import { join } from "node:path";

import { loadSkills } from "@crest/agent/harness/skills";
import type { Skill } from "@crest/agent/harness/types";
import { NodeExecutionEnv } from "@crest/agent/node";
import { defaultConfigHome } from "./sessions";

/** Project-local config dir name (mirrors pi's `.pi`). */
const PROJECT_CONFIG_DIR = ".crest";

/**
 * Default skill directories for a pane, global first then project-local:
 *   1. <configHome>/skills   — user-global skills
 *   2. <cwd>/.crest/skills   — project-local skills
 */
export function defaultSkillDirs(cwd: string, configHome: string = defaultConfigHome()): string[] {
    return [join(configHome, "skills"), join(cwd, PROJECT_CONFIG_DIR, "skills")];
}

/**
 * Discover and load skills for a pane. Runs at agent-session setup
 * (like loadProjectContextFiles), so it constructs a throwaway
 * NodeExecutionEnv whose cwd is the pane's cwd. Missing directories are
 * skipped by loadSkills; diagnostics are logged but never throw.
 */
export async function loadAgentSkills(options: { cwd: string; configHome?: string }): Promise<Skill[]> {
    const dirs = defaultSkillDirs(options.cwd, options.configHome ?? defaultConfigHome());
    const env = new NodeExecutionEnv({ cwd: options.cwd });
    const { skills, diagnostics } = await loadSkills(env, dirs);
    for (const diagnostic of diagnostics) {
        console.warn(`[agent-ipc] skill ${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`);
    }
    return skills;
}
