// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as jotai from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitReviewSidebar, openCodeReviewGitDiff } from "./git-panel";

const mockGitPanel = vi.hoisted(() => {
    const state = {
        model: null as any,
        layoutModel: null as any,
    };
    return state;
});

vi.mock("react", async () => {
    const reactActual = await vi.importActual<typeof import("react")>("react");
    return {
        ...reactActual,
        useEffect: () => undefined,
    };
});

vi.mock("@/app/store/contextmenu", () => ({
    ContextMenuModel: {
        getInstance: () => ({
            showContextMenu: vi.fn(),
        }),
    },
}));

vi.mock("@/app/store/jotaiStore", () => ({
    globalStore: {
        get: vi.fn(),
        set: vi.fn(),
    },
}));

vi.mock("@/store/global", () => ({
    getApi: () => ({
        watchDir: vi.fn(),
        unwatchDir: vi.fn(),
        git: {
            status: vi.fn(),
            diff: vi.fn(),
        },
    }),
}));

vi.mock("@/app/element/ui-icon", () => ({
    UIcon: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("@/app/fileexplorer/file-icon", () => ({
    getFileIcon:
        () =>
        ({ className }: { className?: string }) => <span className={className}>file-icon</span>,
}));

vi.mock("@/util/util", () => ({
    cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
    fireAndForget: (fn: () => unknown) => fn(),
}));

vi.mock("shiki/bundle/web", () => ({
    bundledLanguages: {},
    codeToHtml: vi.fn(),
}));

vi.mock("./git-model", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    mockGitPanel.model = {
        isRepoAtom: jotaiActual.atom(true),
        branchAtom: jotaiActual.atom("feature"),
        mainBranchAtom: jotaiActual.atom("main"),
        totalAddAtom: jotaiActual.atom(1),
        totalDelAtom: jotaiActual.atom(0),
        filesAtom: jotaiActual.atom([]),
        expandedFilesAtom: jotaiActual.atom(new Set()),
        fileDiffsAtom: jotaiActual.atom(new Map()),
        fileStatsAtom: jotaiActual.atom(new Map()),
        loadingFilesAtom: jotaiActual.atom(new Set()),
        loadingAtom: jotaiActual.atom(false),
        errorAtom: jotaiActual.atom(null),
        cwdAtom: jotaiActual.atom("/repo"),
        diffModeAtom: jotaiActual.atom("Head"),
        selectedFileAtom: jotaiActual.atom(null),
        fileSidebarCollapsedAtom: jotaiActual.atom(false),
        commentsAtom: jotaiActual.atom([]),
        syncCwd: vi.fn(),
        refresh: vi.fn(),
        startAutoRefresh: vi.fn(),
        stopAutoRefresh: vi.fn(),
        toggleFileSidebar: vi.fn(),
    };

    return {
        GitModel: {
            getInstance: () => mockGitPanel.model,
        },
        statusGroup: vi.fn(() => "modified"),
    };
});

vi.mock("@/app/workspace/workspace-layout-model", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    mockGitPanel.layoutModel = {
        rightToolPanelAtom: jotaiActual.atom({
            visible: true,
            width: 400,
            openedTools: ["codeReview"],
            activeTool: "codeReview",
            toolState: {},
            focused: true,
            magnified: false,
        }),
        toggleFocusedRightToolPanelMagnified: vi.fn(),
        setCodeReviewVisible: vi.fn(),
    };
    return {
        WorkspaceLayoutModel: {
            getInstance: () => mockGitPanel.layoutModel,
        },
    };
});

vi.mock("@/app/workspace/top-tab-controller-context", () => ({
    useWorkspaceTopTabController: () => ({ openGitDiff: vi.fn() }),
}));

describe("GitReviewSidebar right panel integration", () => {
    beforeEach(() => {
        const store = jotai.getDefaultStore();
        store.set(mockGitPanel.model.filesAtom, []);
        store.set(mockGitPanel.model.fileStatsAtom, new Map());
        store.set(mockGitPanel.model.selectedFileAtom, null);
        store.set(mockGitPanel.layoutModel.rightToolPanelAtom, {
            visible: true,
            width: 400,
            openedTools: ["codeReview"],
            activeTool: "codeReview",
            toolState: {},
            focused: true,
            magnified: false,
        });
        vi.clearAllMocks();
    });

    it("opens a selected Code Review file through the Top Tab controller", () => {
        const controller = { openGitDiff: vi.fn() };

        openCodeReviewGitDiff(controller, "/repo", { path: "src/app.ts" }, "Head");

        expect(controller.openGitDiff).toHaveBeenCalledWith({
            repoRoot: "/repo",
            path: "src/app.ts",
            mode: "-",
        });
    });

    it("does not render duplicate maximize or close buttons inside the code review header", () => {
        const markup = renderToStaticMarkup(<GitReviewSidebar />);

        expect(markup).not.toContain('aria-label="Maximize panel"');
        expect(markup).not.toContain('aria-label="Collapse panel"');
        expect(markup).not.toContain('aria-label="Close"');
        expect(markup).not.toContain("codeReviewWideAtom");
    });

    it("keeps the file sidebar hidden before the code review tab is magnified", () => {
        const store = jotai.getDefaultStore();
        store.set(mockGitPanel.model.filesAtom, [
            { path: "frontend/app/codereview/git-panel.tsx", status: "M" },
            { path: "frontend/app/codereview/git-model.ts", status: "M" },
        ]);
        store.set(
            mockGitPanel.model.fileStatsAtom,
            new Map([
                ["frontend/app/codereview/git-panel.tsx", { add: 12, del: 4 }],
                ["frontend/app/codereview/git-model.ts", { add: 3, del: 1 }],
            ])
        );

        const markup = renderToStaticMarkup(<GitReviewSidebar />);

        expect(markup).not.toContain('data-code-review-file-sidebar="true"');
        expect(markup).not.toContain("Hide file list");
        expect(markup).not.toContain("Show file list");
    });

    it("keeps branch info left and secondary controls split across the header", () => {
        const store = jotai.getDefaultStore();
        store.set(mockGitPanel.model.filesAtom, [
            { path: "frontend/app/codereview/git-panel.tsx", status: "M" },
            { path: "frontend/app/codereview/git-model.ts", status: "M" },
        ]);

        const markup = renderToStaticMarkup(<GitReviewSidebar />);
        const mainRowIndex = markup.indexOf('data-code-review-header-main-row="true"');
        const branchIndex = markup.indexOf('data-code-review-branch="true"');
        const metaIndex = markup.indexOf('data-code-review-branch-meta="true"');
        const controlRowIndex = markup.indexOf('data-code-review-header-control-row="true"');
        const fileListButtonIndex = markup.indexOf('data-code-review-file-list-button="true"');
        const modeIndex = markup.indexOf("Uncommitted changes");
        const actionsIndex = markup.indexOf('data-code-review-header-actions="true"');

        expect(mainRowIndex).toBeGreaterThanOrEqual(0);
        expect(branchIndex).toBeGreaterThan(mainRowIndex);
        expect(metaIndex).toBeGreaterThan(branchIndex);
        expect(controlRowIndex).toBeGreaterThan(metaIndex);
        expect(fileListButtonIndex).toBeGreaterThan(controlRowIndex);
        expect(modeIndex).toBeGreaterThan(fileListButtonIndex);
        expect(actionsIndex).toBeGreaterThan(modeIndex);
        expect(markup).toContain("Open file list");
    });

    it("shows a simplified file sidebar only when the code review tab is magnified", () => {
        const store = jotai.getDefaultStore();
        store.set(mockGitPanel.model.filesAtom, [
            { path: "frontend/app/codereview/git-panel.tsx", status: "M" },
            { path: "frontend/app/codereview/git-model.ts", status: "M" },
        ]);
        store.set(
            mockGitPanel.model.fileStatsAtom,
            new Map([
                ["frontend/app/codereview/git-panel.tsx", { add: 12, del: 4 }],
                ["frontend/app/codereview/git-model.ts", { add: 3, del: 1 }],
            ])
        );
        store.set(mockGitPanel.layoutModel.rightToolPanelAtom, {
            visible: true,
            width: 400,
            openedTools: ["codeReview"],
            activeTool: "codeReview",
            toolState: {},
            focused: true,
            magnified: true,
        });

        const markup = renderToStaticMarkup(<GitReviewSidebar />);

        expect(markup).toContain('data-code-review-file-sidebar="true"');
        expect(markup).toContain("Changed files");
        expect(markup).toContain("git-panel.tsx");
        expect(markup).toContain("git-model.ts");
        expect(markup).toContain('data-code-review-file-row="true"');
    });
});
