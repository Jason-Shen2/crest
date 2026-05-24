// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Tools registry. The file-IO + listing + shell tools (read / write /
// edit / ls / bash) are ported from pi's coding-agent package
// (earendil-works/pi) with the pi-tui render layer stripped — pi's
// implementations have smarter truncation, fuzzy-matched multi-edit,
// line-ending preservation, and process-tree-kill shell execution beyond
// the hand-written originals they replace. web_fetch is still crest's own
// (pi has none). pi's find + grep are follow-ups — they shell out to
// fd / ripgrep, which is a binary-distribution decision for the Electron
// packaging.
//
// pi's tools are cwd-bound: getDefaultTools(cwd) constructs them against
// the pane's cwd so the LLM can use relative paths.

import type { AgentTool } from "../types";
import { createBashTool } from "./bash";
import { createEditTool } from "./edit";
import { createLsTool } from "./ls";
import { createReadTool } from "./read";
import { webFetchTool } from "./web-fetch";
import { createWriteTool } from "./write";

export { createBashTool } from "./bash";
export { createEditTool } from "./edit";
export { createLsTool } from "./ls";
export { createReadTool } from "./read";
export { webFetchTool } from "./web-fetch";
export { createWriteTool } from "./write";

/**
 * Default tools enabled for every pane, bound to the pane's cwd. The IPC
 * layer passes this (or a filtered subset) to buildPaneHarness.
 */
export function getDefaultTools(cwd: string): AgentTool[] {
    return [
        createReadTool(cwd),
        createWriteTool(cwd),
        createEditTool(cwd),
        createLsTool(cwd),
        createBashTool(cwd),
        webFetchTool,
    ];
}

/**
 * Tool names enabled by default. Useful for buildPermissionsHook's
 * allowedTools list when callers want to enable only a subset.
 */
export const DEFAULT_TOOL_NAMES = ["read", "write", "edit", "ls", "bash", "web_fetch"] as const;
