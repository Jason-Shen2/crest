// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { RightToolPanelState } from "@/app/workspace/right-tool-panel-state";
import { DefaultRightToolPanelState } from "@/app/workspace/right-tool-panel-state";
import * as jotai from "jotai";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mockTopBar = vi.hoisted(() => ({
    workspaceAtom: null as jotai.PrimitiveAtom<Workspace>,
    fullScreenAtom: null as jotai.PrimitiveAtom<boolean>,
    leftPanelAtom: null as jotai.PrimitiveAtom<any>,
    rightToolPanelAtom: null as jotai.PrimitiveAtom<RightToolPanelState>,
    activePanelAtom: null as jotai.PrimitiveAtom<string | null>,
    unreadCountAtom: null as jotai.PrimitiveAtom<number>,
    layoutModel: null as any,
    handlers: new Map<string, () => void>(),
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
    }) => {
        if (divOnClick) {
            mockTopBar.handlers.set(content, divOnClick);
        }
        return (
            <button type="button" aria-label={content} className={divClassName} onClick={divOnClick}>
                {children}
            </button>
        );
    },
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

vi.mock("@/app/workspace/workspace-layout-model", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    mockTopBar.rightToolPanelAtom = jotaiActual.atom({
        ...DefaultRightToolPanelState,
        visible: true,
    });
    mockTopBar.leftPanelAtom = jotaiActual.atom({ visible: true, mode: "files", width: 260 });
    mockTopBar.layoutModel = {
        leftPanelAtom: mockTopBar.leftPanelAtom,
        rightToolPanelAtom: mockTopBar.rightToolPanelAtom,
        getLeftPanelStateForWorkspace: vi.fn((_workspaceId: string, state: any) => state),
        toggleLeftPanel: vi.fn(),
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

        expect(markup).toContain('aria-label="Files"');
        expect(markup).toContain('aria-label="Agent Sessions"');
        expect(markup).toContain('aria-label="Terminal"');
        // Workspace switcher pill is in the topbar (mocked).
        expect(markup).toContain("mock-workspace-switcher");

        expect(markup).not.toContain("mock-tabbar");

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

    it("toggles all three left panel modes and only marks the visible mode active", () => {
        const markup = renderToStaticMarkup(
            <TopBar workspace={jotai.getDefaultStore().get(mockTopBar.workspaceAtom)} />
        );

        expect(markup).toContain('aria-label="Files" class="topbar-icon-btn is-active"');
        expect(markup).toContain('aria-label="Agent Sessions" class="topbar-icon-btn "');
        expect(markup).toContain('aria-label="Terminal" class="topbar-icon-btn "');

        mockTopBar.handlers.get("Files")?.();
        mockTopBar.handlers.get("Agent Sessions")?.();
        mockTopBar.handlers.get("Terminal")?.();

        expect(mockTopBar.layoutModel.toggleLeftPanel.mock.calls).toEqual([["files"], ["sessions"], ["terminals"]]);
    });

    it("uses the target workspace left panel state for active buttons on the first frame", () => {
        const wsB = {
            ...jotai.getDefaultStore().get(mockTopBar.workspaceAtom),
            oid: "ws-b",
        };
        mockTopBar.layoutModel.getLeftPanelStateForWorkspace = vi.fn((workspaceId: string, state: any) =>
            workspaceId === "ws-b" ? { visible: true, mode: "terminals", width: 340 } : state
        );

        const markup = renderToStaticMarkup(<TopBar workspace={wsB} />);

        expect(markup).toContain('aria-label="Terminal" class="topbar-icon-btn is-active"');
        expect(markup).toContain('aria-label="Files" class="topbar-icon-btn "');
        expect(markup).toContain('aria-label="Agent Sessions" class="topbar-icon-btn "');
    });

    it("renders the fixed Agent entry separately from the Agent Sessions panel button", () => {
        const markup = renderToStaticMarkup(
            <TopBar
                workspace={jotai.getDefaultStore().get(mockTopBar.workspaceAtom)}
                agentActive
                onActivateAgent={vi.fn()}
            />
        );

        expect(markup).toContain('aria-label="Agent Sessions"');
        expect(markup).toContain('aria-label="Agent"');
        expect(markup).toContain('aria-pressed="true"');
    });

    it("renders workspace Top Tabs in the same topbar row immediately after Agent", () => {
        const markup = renderToStaticMarkup(
            <TopBar
                workspace={jotai.getDefaultStore().get(mockTopBar.workspaceAtom)}
                onActivateAgent={vi.fn()}
                topTabStrip={<div data-testid="workspace-top-tabs">file tabs</div>}
            />
        );

        expect(markup).toContain('data-testid="workspace-top-tabs"');
        expect(markup.indexOf('aria-label="Agent"')).toBeLessThan(markup.indexOf('data-testid="workspace-top-tabs"'));
    });
});
