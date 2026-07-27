// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { openGitDiffTab } from "./open-git-diff-tab";

describe("openGitDiffTab", () => {
    it("delegates only to the Workspace Top Tab controller", async () => {
        const controller = { openGitDiff: vi.fn().mockReturnValue("diff-1") };
        const input = { repoRoot: "/repo", path: "src/app.ts", mode: "-" as const };
        await expect(openGitDiffTab(input, controller)).resolves.toEqual({ tabId: "diff-1", created: true });
        expect(controller.openGitDiff).toHaveBeenCalledWith({ ...input, originalPath: undefined });
    });
});
