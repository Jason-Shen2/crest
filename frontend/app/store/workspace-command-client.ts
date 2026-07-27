// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { isAbsoluteLocalPath } from "@/util/local-path";
import { getApi } from "./global";

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function validateWorkspaceCommand(command: WorkspaceCommand): void {
    switch (command.type) {
        case "open-url": {
            if (!isNonEmptyString(command.url)) {
                throw new Error("Workspace URL is required");
            }
            const parsed = new URL(command.url);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                throw new Error("Workspace URL must use http(s)");
            }
            return;
        }
        case "open-file":
        case "open-preview":
            if (!isAbsoluteLocalPath(command.path)) {
                throw new Error("Workspace content path must be absolute");
            }
            return;
        case "open-git-diff":
            if (
                !isAbsoluteLocalPath(command.repoRoot) ||
                !isNonEmptyString(command.path) ||
                (command.mode !== "+" && command.mode !== "-") ||
                (command.originalPath != null && typeof command.originalPath !== "string")
            ) {
                throw new Error("Invalid Workspace Git diff command");
            }
            return;
        default:
            return;
    }
}

export function sendWorkspaceCommand(command: WorkspaceCommand): void {
    validateWorkspaceCommand(command);
    getApi().sendWorkspaceCommand(command);
}
