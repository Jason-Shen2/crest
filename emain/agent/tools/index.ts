// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Tools registry. The file-IO + listing tools (read / write / edit / ls)
// are ported from pi's coding-agent package (earendil-works/pi) with the
// pi-tui render layer stripped — pi's implementations have smarter
// truncation, fuzzy-matched multi-edit, and line-ending preservation
// than the hand-written originals they replace. shell_exec and web_fetch
// are still crest's own (pi has no web_fetch; pi's bash + find + grep are
// follow-ups — bash needs pi's shell-utils, find/grep need fd/ripgrep).
//
// pi's file tools are cwd-bound: getDefaultTools(cwd) constructs them
// against the pane's cwd so the LLM can use relative paths.

import type { AgentTool } from "../types";
import { createEditTool } from "./edit";
import { createLsTool } from "./ls";
import { createReadTool } from "./read";
import { shellExecTool } from "./shell-exec";
import { webFetchTool } from "./web-fetch";
import { createWriteTool } from "./write";

export { createEditTool } from "./edit";
export { createLsTool } from "./ls";
export { createReadTool } from "./read";
export { shellExecTool } from "./shell-exec";
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
        webFetchTool,
        shellExecTool,
    ];
}

/**
 * Tool names enabled by default. Useful for buildPermissionsHook's
 * allowedTools list when callers want to enable only a subset.
 */
export const DEFAULT_TOOL_NAMES = ["read", "write", "edit", "ls", "web_fetch", "shell_exec"] as const;
