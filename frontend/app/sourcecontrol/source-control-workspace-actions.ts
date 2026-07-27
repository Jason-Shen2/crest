// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { OpenGitDiffTabInput } from "./open-git-diff-tab";

export interface SourceControlWorkspaceActions {
    openGitDiff(input: OpenGitDiffTabInput): void;
}
