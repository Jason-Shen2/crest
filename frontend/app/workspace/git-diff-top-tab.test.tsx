// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitDiffTopTab } from "./git-diff-top-tab";

vi.mock("@/app/gitdiff/git-diff-pane", () => ({
    GitDiffContent: ({ descriptor }: any) => <div data-testid="git-diff-content">{JSON.stringify(descriptor)}</div>,
}));

afterEach(cleanup);

describe("GitDiffTopTab", () => {
    it.each([
        ["+", true],
        ["-", false],
    ] as const)("forwards the %s tab descriptor without Block or ViewModel state", (mode) => {
        render(
            <GitDiffTopTab
                tab={{
                    id: "diff-1",
                    kind: "git-diff",
                    repoRoot: "/repo",
                    path: "src/new.ts",
                    mode,
                    originalPath: "src/old.ts",
                    title: "new.ts",
                }}
            />
        );

        expect(JSON.parse(screen.getByTestId("git-diff-content").textContent ?? "")).toEqual({
            repoRoot: "/repo",
            path: "src/new.ts",
            mode,
            originalPath: "src/old.ts",
        });
    });
});
