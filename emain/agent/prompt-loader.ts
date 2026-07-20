// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// prompt-loader.ts — discovers and loads agent prompt templates at session setup.
// Mirrors skills-loader.ts, using crest's config-home + project-local prompt
// directories plus extension package `pi.prompts` manifest entries.

import { join } from "node:path";

import { discoverExtensionManifestResourcePaths } from "./extensions";
import { loadPromptTemplates } from "./harness/prompt-templates";
import type { PromptTemplate } from "./harness/types";
import { NodeExecutionEnv } from "./node";
import { defaultConfigHome } from "./sessions";

/** Project-local config dir name (mirrors pi's `.pi`). */
const PROJECT_CONFIG_DIR = ".crest";

/**
 * Default prompt-template directories for a pane, global first then project-local:
 *   1. <configHome>/prompts   — user-global prompt templates
 *   2. <cwd>/.crest/prompts   — project-local prompt templates
 */
export function defaultPromptTemplateDirs(cwd: string, configHome: string = defaultConfigHome()): string[] {
    return [join(configHome, "prompts"), join(cwd, PROJECT_CONFIG_DIR, "prompts")];
}

/**
 * Discover and load prompt templates for a pane. Missing directories are
 * skipped by loadPromptTemplates; diagnostics are logged but never throw.
 */
export async function loadAgentPromptTemplates(options: {
    cwd: string;
    configHome?: string;
}): Promise<PromptTemplate[]> {
    const configHome = options.configHome ?? defaultConfigHome();
    const dirs = [
        ...defaultPromptTemplateDirs(options.cwd, configHome),
        ...discoverExtensionManifestResourcePaths({ cwd: options.cwd, configHome, field: "prompts" }),
    ];
    const env = new NodeExecutionEnv({ cwd: options.cwd });
    const { promptTemplates, diagnostics } = await loadPromptTemplates(env, dirs);
    for (const diagnostic of diagnostics) {
        console.warn(`[agent-ipc] prompt ${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`);
    }
    return promptTemplates;
}
