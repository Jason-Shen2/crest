// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceTopTabController } from "@/app/workspace/top-tab-controller";

export type GitDiffMode = "+" | "-";

export type OpenGitDiffTabInput = {
    repoRoot: string;
    path: string;
    mode: GitDiffMode;
    originalPath?: string | null;
};

export type OpenGitDiffTabResult = {
    tabId: string;
    created: boolean;
};

export async function openGitDiffTab(
    input: OpenGitDiffTabInput,
    controller: Pick<WorkspaceTopTabController, "openGitDiff">
): Promise<OpenGitDiffTabResult> {
    const tabId = controller.openGitDiff({
        ...input,
        originalPath: input.originalPath ?? undefined,
    });
    return { tabId, created: true };
}
