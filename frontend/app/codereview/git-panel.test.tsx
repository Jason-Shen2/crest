// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { isValidElement, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CodeReviewPanelMagnifyButton, GitReviewSidebar } from "./git-panel";

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
        useEffect: (effect: () => void | (() => void)) => {
            effect();
        },
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

describe("GitReviewSidebar right panel integration", () => {
    it("uses the right tool panel magnify state and action for its maximize button", () => {
        const markup = renderToStaticMarkup(<GitReviewSidebar />);

        expect(markup).toContain('aria-label="Maximize panel"');
        expect(markup).not.toContain("codeReviewWideAtom");
    });

    it("toggles right panel magnify from the code review maximize button", () => {
        const onToggle = vi.fn();
        const button = CodeReviewPanelMagnifyButton({ magnified: false, onToggle });

        expect(isValidElement(button)).toBe(true);
        expect((button as ReactElement<{ title: string; onClick: () => void }>).props.title).toBe("Maximize panel");

        (button as ReactElement<{ onClick: () => void }>).props.onClick();

        expect(onToggle).toHaveBeenCalledTimes(1);
    });
});
