// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shared change-operation details emitted by file-mutating agent tools so
// review UIs can reason about writes and edits without parsing tool text.

import { createHash } from "node:crypto";

export type ChangeOperationKind = "patch" | "write" | "create" | "delete" | "rename";

export interface ChangeOperation {
    id: string;
    runId?: string;
    toolCallId?: string;
    kind: ChangeOperationKind;
    path: string;
    previousPath?: string;
    patch?: string;
    patchStatus?: "complete" | "unavailable";
    patchUnavailableReason?: string;
    beforeContentHash?: string;
    afterContentHash?: string;
}

export interface MakeToolChangeOperationInput {
    toolCallId: string;
    kind: ChangeOperationKind;
    path: string;
    patch?: string;
    patchStatus?: "complete" | "unavailable";
    patchUnavailableReason?: string;
}

export function makeToolChangeOperation(input: MakeToolChangeOperationInput): ChangeOperation {
    const id = createHash("sha256")
        .update(`${input.toolCallId}\0${input.kind}\0${input.path}\0${input.patch ?? ""}`)
        .digest("hex")
        .slice(0, 16);
    return {
        id,
        toolCallId: input.toolCallId,
        kind: input.kind,
        path: input.path,
        ...(input.patch !== undefined ? { patch: input.patch } : {}),
        ...(input.patchStatus !== undefined ? { patchStatus: input.patchStatus } : {}),
        ...(input.patchUnavailableReason !== undefined
            ? { patchUnavailableReason: input.patchUnavailableReason }
            : {}),
    };
}
