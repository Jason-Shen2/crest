// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Tools registry. v1 ships a pure-Node baseline (read / write /
// edit / list / web / shell) sufficient for the agent to do real
// coding work. Tools that need wavesrv state via wshrpc
// (create_block, focus_block, get_scrollback, browser, ask_user_question,
// transfer_to_user, spawn_task, cmd_history, file_tracker, dangerous)
// are TODO — they were deferred by the autonomous-session handoff
// because they need design decisions about the renderer/wavesrv
// bridge.

import type { AgentTool } from "../types";
import { listDirTool } from "./list-dir";
import { multiEditTool } from "./multi-edit";
import { readFileTool } from "./read-file";
import { shellExecTool } from "./shell-exec";
import { webFetchTool } from "./web-fetch";
import { writeFileTool } from "./write-file";

export { listDirTool } from "./list-dir";
export { multiEditTool } from "./multi-edit";
export { readFileTool } from "./read-file";
export { shellExecTool } from "./shell-exec";
export { webFetchTool } from "./web-fetch";
export { writeFileTool } from "./write-file";

/**
 * Default tools enabled for every pane. The IPC layer passes this
 * (or a filtered subset) to buildPaneHarness.
 */
export function getDefaultTools(): AgentTool[] {
    return [readFileTool, writeFileTool, multiEditTool, listDirTool, webFetchTool, shellExecTool];
}

/**
 * Tool names defined in v1. Useful for buildPermissionsHook's
 * allowedTools list when callers want to enable only a subset.
 */
export const DEFAULT_TOOL_NAMES = [
    "read_file",
    "write_file",
    "multi_edit",
    "list_dir",
    "web_fetch",
    "shell_exec",
] as const;
