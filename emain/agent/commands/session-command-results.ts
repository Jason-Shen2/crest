// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentCommandExecutionResult } from "./types";

export function commandSuccess(message: string): AgentCommandExecutionResult {
    return { status: "success", message };
}

export function commandNoop(message: string): AgentCommandExecutionResult {
    return { status: "noop", message };
}
