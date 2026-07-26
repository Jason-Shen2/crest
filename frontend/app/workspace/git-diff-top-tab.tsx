// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { GitDiffContent } from "@/app/gitdiff/git-diff-pane";
import type { TopTab } from "./workspace-content-state";

type GitDiffTab = Extract<TopTab, { kind: "git-diff" }>;

export function GitDiffTopTab({ tab }: { tab: GitDiffTab }) {
    return (
        <GitDiffContent
            descriptor={{
                repoRoot: tab.repoRoot,
                path: tab.path,
                mode: tab.mode,
                originalPath: tab.originalPath,
            }}
        />
    );
}
