// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type GitDiffMode = "+" | "-";

export type GitDiffMeta = {
    repoRoot: string;
    path: string;
    mode: GitDiffMode;
    originalPath: string;
};

export type GitDiffContent = {
    originalContent: string;
    modifiedContent: string;
    isBinary: boolean;
    fallbackPatch: string;
    truncated: boolean;
};
