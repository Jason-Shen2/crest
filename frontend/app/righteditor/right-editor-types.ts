// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type RightEditorSaveStatus = "idle" | "saving" | "saved" | "error";

export type RightEditorOpenFile = {
    path: string;
    uri: string;
    language: string;
    readonly: boolean;
    savedText: string;
    dirtyText: string | null;
    saveStatus: RightEditorSaveStatus;
    error: string | null;
};

export type RightEditorState = {
    openFiles: RightEditorOpenFile[];
    activePath: string | null;
    workspaceRoot: string;
};

export type RightEditorLspStatus = {
    language: string;
    workspaceRoot: string;
    state: "stopped" | "starting" | "running" | "error";
    message: string | null;
};
