// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Tools registry. The file-IO + listing + shell tools (read / write /
// edit / ls / bash) are ported from pi's coding-agent package
// (earendil-works/pi) with the pi-tui render layer stripped — pi's
// implementations have smarter truncation, fuzzy-matched multi-edit,
// line-ending preservation, and process-tree-kill shell execution beyond
// the hand-written originals they replace. web_fetch is still crest's own
// (pi has none). pi's find + grep shell out to fd / ripgrep; crest
// implements them in pure Node instead (glob + ignore, see ./_search) so
// the Electron app never downloads binaries at runtime.
//
// pi's tools are cwd-bound. getDefaultTools also accepts a cwd reader so a
// long-lived session runtime can resolve relative paths against its current
// execution context without rebuilding the Harness.

import type { AgentTool } from "@crest/agent/types";
import { createBashTool } from "./bash";
import { createEditTool } from "./edit";
import { createFindTool } from "./find";
import { createGrepTool } from "./grep";
import { createLsTool } from "./ls";
import { createReadTool } from "./read";
import { webFetchTool } from "./web-fetch";
import { createWriteTool } from "./write";

export { createBashTool } from "./bash";
export { createEditTool } from "./edit";
export { createFindTool } from "./find";
export { createGrepTool } from "./grep";
export { createLsTool } from "./ls";
export { createReadTool } from "./read";
export { webFetchTool } from "./web-fetch";
export { createWriteTool } from "./write";

type CwdInput = string | (() => string);
type CwdToolFactory = (cwd: string) => AgentTool;

function makeCwdReader(cwd: CwdInput): () => string {
    return typeof cwd === "function" ? cwd : () => cwd;
}

function createDynamicCwdTool(factory: CwdToolFactory, getCwd: () => string): AgentTool {
    const tool = factory(getCwd());
    return {
        ...tool,
        execute: (toolCallId, params, signal, onUpdate) =>
            factory(getCwd()).execute(toolCallId, params, signal, onUpdate),
    };
}

/**
 * Default tools enabled for every pane, bound to the pane's cwd. The IPC
 * layer passes this (or a filtered subset) to buildAgentHarnessHost.
 */
export function getDefaultTools(cwd: CwdInput): AgentTool[] {
    const getCwd = makeCwdReader(cwd);
    return [
        createDynamicCwdTool(createReadTool, getCwd),
        createDynamicCwdTool(createWriteTool, getCwd),
        createDynamicCwdTool(createEditTool, getCwd),
        createDynamicCwdTool(createLsTool, getCwd),
        createDynamicCwdTool(createBashTool, getCwd),
        createDynamicCwdTool(createFindTool, getCwd),
        createDynamicCwdTool(createGrepTool, getCwd),
        webFetchTool,
    ];
}

/**
 * Tool names enabled by default. Useful for buildPermissionsHook's
 * allowedTools list when callers want to enable only a subset.
 */
export const DEFAULT_TOOL_NAMES = ["read", "write", "edit", "ls", "bash", "find", "grep", "web_fetch"] as const;
