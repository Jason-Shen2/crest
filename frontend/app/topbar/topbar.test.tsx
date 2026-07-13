// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as jotai from "jotai";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DefaultRightToolPanelState } from "@/app/workspace/right-tool-panel-state";
import type { RightToolPanelState } from "@/app/workspace/right-tool-panel-state";

const mockTopBar = vi.hoisted(() => ({
    workspaceAtom: null as jotai.PrimitiveAtom<Workspace>,
    fullScreenAtom: null as jotai.PrimitiveAtom<boolean>,
    vtabVisibleAtom: null as jotai.PrimitiveAtom<boolean>,
    fileExplorerVisibleAtom: null as jotai.PrimitiveAtom<boolean>,
    rightToolPanelAtom: null as jotai.PrimitiveAtom<RightToolPanelState>,
    activePanelAtom: null as jotai.PrimitiveAtom<string | null>,
    unreadCountAtom: null as jotai.PrimitiveAtom<number>,
    layoutModel: null as any,
}));

vi.mock("@/app/element/tooltip", () => ({
    Tooltip: ({
        children,
        content,
        divClassName,
        divOnClick,
    }: {
        children: ReactNode;
        content: string;
        divClassName?: string;
        divOnClick?: () => void;
    }) => (
        <button type="button" aria-label={content} className={divClassName} onClick={divOnClick}>
            {children}
        </button>
    ),
}));

vi.mock("@/app/store/global", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    mockTopBar.workspaceAtom = jotaiActual.atom({
        otype: "workspace",
        oid: "ws-a",
        version: 1,
        meta: {},
        tabids: [],
        activetabid: "",
    } as Workspace);
    mockTopBar.fullScreenAtom = jotaiActual.atom(false);
    return {
        atoms: {
            workspace: mockTopBar.workspaceAtom,
            isFullScreen: mockTopBar.fullScreenAtom,
        },
    };
});

vi.mock("@/app/store/modalmodel", () => ({
    modalsModel: {
        isModalOpen: () => false,
        pushModal: vi.fn(),
        popModal: vi.fn(),
    },
}));

vi.mock("@/app/tab/workspaceswitcher", () => ({
    WorkspaceSwitcher: () => <div className="mock-workspace-switcher">Workspace Switcher</div>,
}));

vi.mock("@/app/tab/tabbar", () => ({
    TabBar: () => <div className="mock-tabbar">TabBar</div>,
}));

vi.mock("@/app/workspace/workspace-layout-model", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    mockTopBar.rightToolPanelAtom = jotaiActual.atom({
        ...DefaultRightToolPanelState,
        visible: true,
    });
    mockTopBar.vtabVisibleAtom = jotaiActual.atom(false);
    mockTopBar.fileExplorerVisibleAtom = jotaiActual.atom(true);
    mockTopBar.layoutModel = {
        vtabVisibleAtom: mockTopBar.vtabVisibleAtom,
        fileExplorerVisibleAtom: mockTopBar.fileExplorerVisibleAtom,
        rightToolPanelAtom: mockTopBar.rightToolPanelAtom,
        getVTabVisible: () => false,
        setVTabVisible: vi.fn(),
        getFileExplorerVisible: () => true,
        setFileExplorerVisible: vi.fn(),
        getRightToolPanelStateForWorkspace: vi.fn((_workspaceId: string, state: RightToolPanelState) => state),
        setRightToolPanelFocused: vi.fn(),
        setRightToolPanelVisible: vi.fn(),
    };
    return {
        WorkspaceLayoutModel: {
            getInstance: () => mockTopBar.layoutModel,
        },
    };
});

vi.mock("@/app/github/github-model", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    mockTopBar.activePanelAtom = jotaiActual.atom(null);
    return {
        GitHubModel: {
            getInstance: () => ({
                activePanelAtom: mockTopBar.activePanelAtom,
                togglePanel: vi.fn(),
            }),
        },
    };
});

vi.mock("@/app/notifications/notifications-model", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    mockTopBar.unreadCountAtom = jotaiActual.atom(0);
    return {
        NotificationsModel: {
            getInstance: () => ({
                unreadCountAtom: mockTopBar.unreadCountAtom,
            }),
        },
    };
});

vi.mock("@/app/notifications/notifications-panel", () => ({
    NotificationsPanel: () => <div>Notifications Panel</div>,
}));

vi.mock("@/util/platformutil", () => ({
    isMacOS: () => false,
    isMacOSTahoeOrLater: () => false,
}));

import { TopBar } from "./topbar";

describe("TopBar chrome layout", () => {
    it("renders the 5-region chrome with terax-style buttons, workspace pill, and right panel toggle", () => {
        const mockWorkspace: Workspace = {
            otype: "workspace",
            oid: "ws-a",
            version: 1,
            meta: {},
            tabids: [],
            activetabid: "",
            name: "Test",
            icon: "computer",
            color: "#10b981",
        } as Workspace;
        const markup = renderToStaticMarkup(<TopBar workspace={mockWorkspace} />);

        // Left chrome: file explorer toggle + command palette button.
        expect(markup).toContain('aria-label="Toggle File Explorer"');
        expect(markup).toContain('title="Search files, commands"');

        // Workspace switcher pill is in the topbar (mocked).
        expect(markup).toContain("mock-workspace-switcher");

        // TabBar (mocked) is embedded in the topbar.
        expect(markup).toContain("mock-tabbar");

        // Right chrome: right-panel toggle + notifications + settings.
        expect(markup).toContain('title="Search"');
        expect(markup).toContain("topbar-search-kbd-command");
        expect(markup).toContain("topbar-search-kbd-key");
        expect(markup).toContain("⌘");
        expect(markup).toContain("P");
        expect(markup).not.toContain("<kbd");
        expect(markup).not.toContain("Cmd K");
        expect(markup).toContain('aria-label="Toggle Right Panel"');
        expect(markup).toContain('aria-label="Notifications"');
        expect(markup).toContain('aria-label="Settings"');
    });
});
