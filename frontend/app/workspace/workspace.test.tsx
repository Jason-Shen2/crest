// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import * as jotai from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DefaultRightToolPanelState, RightToolPanelState } from "./right-tool-panel-state";
import { Workspace } from "./workspace";

const mockLayout = vi.hoisted(() => {
    const state = {
        staticTabIdAtom: null as jotai.PrimitiveAtom<string>,
        workspaceAtom: null as jotai.PrimitiveAtom<Workspace>,
        isFullScreenAtom: null as jotai.PrimitiveAtom<boolean>,
        tabBarSettingAtom: null as jotai.PrimitiveAtom<string>,
        vtabVisibleAtom: null as jotai.PrimitiveAtom<boolean>,
        fileExplorerVisibleAtom: null as jotai.PrimitiveAtom<boolean>,
        vtabWidthAtom: null as jotai.PrimitiveAtom<number>,
        fileExplorerWidthAtom: null as jotai.PrimitiveAtom<number>,
        codeReviewVisibleAtom: null as jotai.PrimitiveAtom<boolean>,
        codeReviewWideAtom: null as jotai.PrimitiveAtom<boolean>,
        rightToolPanelAtom: null as jotai.PrimitiveAtom<RightToolPanelState>,
        tabContentMock: null as any,
        topBarProps: null as any,
        rightResizeHandleProps: null as any,
        model: null as any,
    };
    return state;
});

const defaultRightToolPanelState = vi.hoisted(() => ({
    visible: true,
    width: 400,
    openedTools: [],
    activeTool: undefined,
    toolState: {},
    focused: false,
    magnified: false,
}));

vi.mock("@/store/global", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    mockLayout.staticTabIdAtom = jotaiActual.atom("tab-a");
    mockLayout.workspaceAtom = jotaiActual.atom({
        otype: "workspace",
        oid: "ws-a",
        version: 1,
        meta: {},
        tabids: ["tab-a"],
        activetabid: "tab-a",
    } as Workspace);
    mockLayout.isFullScreenAtom = jotaiActual.atom(false);
    mockLayout.tabBarSettingAtom = jotaiActual.atom("top");

    return {
        atoms: {
            staticTabId: mockLayout.staticTabIdAtom,
            workspace: mockLayout.workspaceAtom,
            isFullScreen: mockLayout.isFullScreenAtom,
        },
        getSettingsKeyAtom: () => mockLayout.tabBarSettingAtom,
    };
});

vi.mock("@/app/workspace/workspace-layout-model", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    mockLayout.vtabVisibleAtom = jotaiActual.atom(false);
    mockLayout.fileExplorerVisibleAtom = jotaiActual.atom(false);
    mockLayout.vtabWidthAtom = jotaiActual.atom(248);
    mockLayout.fileExplorerWidthAtom = jotaiActual.atom(260);
    mockLayout.codeReviewVisibleAtom = jotaiActual.atom(true);
    mockLayout.codeReviewWideAtom = jotaiActual.atom(false);
    mockLayout.rightToolPanelAtom = jotaiActual.atom({
        ...defaultRightToolPanelState,
        width: 420,
        openedTools: ["codeReview"],
        activeTool: "codeReview",
    });
    mockLayout.model = {
        vtabVisibleAtom: mockLayout.vtabVisibleAtom,
        fileExplorerVisibleAtom: mockLayout.fileExplorerVisibleAtom,
        vtabWidthAtom: mockLayout.vtabWidthAtom,
        fileExplorerWidthAtom: mockLayout.fileExplorerWidthAtom,
        codeReviewVisibleAtom: mockLayout.codeReviewVisibleAtom,
        codeReviewWideAtom: mockLayout.codeReviewWideAtom,
        rightToolPanelAtom: mockLayout.rightToolPanelAtom,
        getRightToolPanelStateForWorkspace: vi.fn((_workspaceId: string, state: RightToolPanelState) => state),
        hydrateRightToolPanelFromWorkspace: vi.fn(),
        setVTabVisible: vi.fn(),
        getVTabMinWidth: () => 200,
        getVTabMaxWidth: () => 360,
        getFileExplorerMinWidth: () => 180,
        getFileExplorerMaxWidth: () => 500,
        getRightToolPanelMaxWidth: () => 840,
        setVTabWidth: vi.fn(),
        setFileExplorerWidth: vi.fn(),
        previewRightToolPanelWidth: vi.fn(),
        setRightToolPanelVisible: vi.fn(),
        setRightToolPanelWidth: vi.fn(),
        openRightTool: vi.fn(),
        selectRightTool: vi.fn(),
        closeRightTool: vi.fn(),
        setRightToolPanelFocused: vi.fn(),
        setRightToolPanelMagnified: vi.fn(),
    };

    return {
        WorkspaceLayoutModel: {
            getInstance: () => mockLayout.model,
        },
    };
});

vi.mock("@/app/element/errorboundary", () => ({
    ErrorBoundary: ({ children }: { children: React.ReactNode }) => (
        <>
            <span data-workspace-error-boundary-start="true" />
            {children}
            <span data-workspace-error-boundary-end="true" />
        </>
    ),
}));

vi.mock("@/app/element/quickelems", () => ({
    CenteredDiv: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/app/fileexplorer/file-explorer", () => ({
    FileExplorer: () => <div>File Explorer</div>,
}));

vi.mock("@/app/modals/modalsrenderer", () => ({
    ModalsRenderer: () => <div>Modals</div>,
}));

vi.mock("@/app/notifications/notification-toast", () => ({
    NotificationToastStacker: () => <div>Notifications</div>,
}));

vi.mock("@/app/notifications/notifications-model", () => ({
    NotificationsModel: {
        getInstance: () => ({
            ensureSubscribed: vi.fn(),
            unreadCountAtom: jotai.atom(0),
        }),
    },
}));

vi.mock("@/app/notifications/notifications-panel", () => ({
    NotificationsPanel: () => <div>Notifications Panel</div>,
}));

vi.mock("@/app/github/github-model", () => ({
    GitHubModel: {
        getInstance: () => ({
            activePanelAtom: jotai.atom(null),
            togglePanel: vi.fn(),
        }),
    },
}));

vi.mock("@/app/codereview/git-panel", () => ({
    GitReviewSidebar: () => <div>Git Review Sidebar</div>,
}));

vi.mock("@/app/tab/tabbar", () => ({
    TabBar: () => <div>Tab Bar</div>,
}));

vi.mock("@/app/topbar/topbar", () => ({
    TopBar: (props: { onPointerDownCapture?: React.PointerEventHandler<HTMLDivElement> }) => {
        mockLayout.topBarProps = props;
        return (
            <div data-testid="topbar" onPointerDownCapture={props.onPointerDownCapture}>
                <i className="fa-code-branch" />
            </div>
        );
    },
}));

vi.mock("@/app/tab/tabcontent", () => ({
    TabContent: (props: { onFocusCapture?: () => void }) => {
        mockLayout.tabContentMock?.(props);
        return <main>Main Tab Content</main>;
    },
}));

vi.mock("@/app/tab/vtabbar", () => ({
    VTabBar: () => <div>Vertical Tabs</div>,
}));

vi.mock("@/app/tab/workspaceswitcher", () => ({
    WorkspaceSwitcher: () => <div>Workspace Switcher</div>,
}));

vi.mock("@/util/platformutil", () => ({
    isMacOS: () => false,
    isMacOSTahoeOrLater: () => false,
}));

vi.mock("@/app/workspace/resize-handle", () => ({
    ResizeHandle: (props: {
        side?: string;
        maxFn?: () => number;
        onResize?: (next: number) => void;
        onResizeEnd?: (final: number) => void;
    }) => {
        if (props.side === "left") {
            mockLayout.rightResizeHandleProps = props;
        }
        return <div aria-label={`Resize ${props.side ?? "right"}`} data-max={props.maxFn?.()} />;
    },
}));

vi.mock("react-resizable-panels", () => ({
    PanelGroup: ({ children }: { children: React.ReactNode }) => <div data-legacy-panel-group="true">{children}</div>,
    Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    PanelResizeHandle: () => <div data-legacy-resize-handle="true" />,
}));

describe("Workspace right tool panel integration", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal("window", { innerWidth: 1200 });
        mockLayout.rightToolPanelAtom = jotai.atom({
            ...DefaultRightToolPanelState,
            width: 420,
            openedTools: ["codeReview"],
            activeTool: "codeReview",
        });
        mockLayout.model.rightToolPanelAtom = mockLayout.rightToolPanelAtom;
        mockLayout.model.getRightToolPanelStateForWorkspace = vi.fn(
            (_workspaceId: string, state: RightToolPanelState) => state
        );
        jotai.getDefaultStore().set(mockLayout.workspaceAtom, {
            otype: "workspace",
            oid: "ws-a",
            version: 1,
            meta: {},
            tabids: ["tab-a"],
            activetabid: "tab-a",
        } as Workspace);
        mockLayout.tabContentMock = vi.fn();
        mockLayout.topBarProps = null;
        mockLayout.rightResizeHandleProps = null;
    });

    it("renders the right tool panel in workspace chrome instead of the legacy code review PanelGroup", () => {
        const markup = renderToStaticMarkup(<Workspace />);

        expect(mockLayout.model.hydrateRightToolPanelFromWorkspace).not.toHaveBeenCalled();
        expect(markup).toContain('aria-label="Right tool panel"');
        expect(markup).toContain('style="width:420px"');
        expect(markup).toContain('aria-label="Select Code Review"');
        expect(markup).toContain("Git Review Sidebar");
        expect(markup).toContain('aria-label="Resize left"');
        expect(markup).not.toContain("data-legacy-panel-group");
        expect(markup).not.toContain("data-legacy-resize-handle");
    });

    it("renders the right panel as a workspace chrome sibling after the main tab content", () => {
        const markup = renderToStaticMarkup(<Workspace />);
        const mainContentIndex = markup.indexOf("<main>Main Tab Content</main>");
        const rightResizeIndex = markup.indexOf('aria-label="Resize left"');
        const rightPanelIndex = markup.indexOf('aria-label="Right tool panel"');

        expect(mainContentIndex).toBeGreaterThanOrEqual(0);
        expect(rightResizeIndex).toBeGreaterThan(mainContentIndex);
        expect(rightPanelIndex).toBeGreaterThan(rightResizeIndex);
    });

    it("keeps right tool panel chrome outside the tab-keyed boundary so tab switches do not remount tool content", () => {
        const markup = renderToStaticMarkup(<Workspace />);
        const boundaryStart = markup.indexOf('data-workspace-error-boundary-start="true"');
        const boundaryEnd = markup.indexOf('data-workspace-error-boundary-end="true"');
        const boundaryContent = markup.slice(boundaryStart, boundaryEnd);

        expect(boundaryStart).toBeGreaterThanOrEqual(0);
        expect(boundaryEnd).toBeGreaterThan(boundaryStart);
        expect(boundaryContent).toContain("<main>Main Tab Content</main>");
        expect(boundaryContent).not.toContain('aria-label="Resize left"');
        expect(boundaryContent).not.toContain('aria-label="Right tool panel"');
        expect(boundaryContent).not.toContain("Git Review Sidebar");
        expect(markup).toContain('aria-label="Right tool panel"');
        expect(markup).toContain("Git Review Sidebar");
    });

    it("does not mount ws-a code review content during ws-b first render before effect hydration", () => {
        jotai.getDefaultStore().set(mockLayout.workspaceAtom, {
            otype: "workspace",
            oid: "ws-b",
            version: 1,
            meta: {},
            tabids: ["tab-b"],
            activetabid: "tab-b",
        } as Workspace);
        mockLayout.model.getRightToolPanelStateForWorkspace = vi.fn(
            (workspaceId: string, state: RightToolPanelState) => {
                if (workspaceId !== "ws-b") {
                    return state;
                }
                return {
                    ...DefaultRightToolPanelState,
                    visible: false,
                    openedTools: [],
                    activeTool: undefined,
                };
            }
        );

        const markup = renderToStaticMarkup(<Workspace />);

        expect(mockLayout.model.getRightToolPanelStateForWorkspace).toHaveBeenCalledWith(
            "ws-b",
            expect.objectContaining({
                openedTools: ["codeReview"],
                activeTool: "codeReview",
            })
        );
        expect(mockLayout.model.hydrateRightToolPanelFromWorkspace).not.toHaveBeenCalled();
        expect(markup).not.toContain("Git Review Sidebar");
        expect(markup).not.toContain('aria-label="Right tool panel"');
        expect(markup).toContain('aria-label="Show right tool panel"');
    });

    it("renders the TopBar Code Review button inactive on the first ws-b render when ws-a left it active", () => {
        jotai.getDefaultStore().set(mockLayout.workspaceAtom, {
            otype: "workspace",
            oid: "ws-b",
            version: 1,
            meta: {},
            tabids: ["tab-b"],
            activetabid: "tab-b",
        } as Workspace);
        mockLayout.model.getRightToolPanelStateForWorkspace = vi.fn(
            (workspaceId: string, state: RightToolPanelState) => {
                if (workspaceId !== "ws-b") {
                    return state;
                }
                return {
                    ...DefaultRightToolPanelState,
                    visible: false,
                    openedTools: [],
                    activeTool: undefined,
                };
            }
        );

        const markup = renderToStaticMarkup(<Workspace />);

        expect(markup).toContain("fa-code-branch");
        expect(markup).not.toContain("text-accent bg-white/10");
    });

    it("clamps the right tool resize budget after visible left panels and the main content floor", () => {
        mockLayout.vtabVisibleAtom = jotai.atom(true);
        mockLayout.fileExplorerVisibleAtom = jotai.atom(true);
        mockLayout.vtabWidthAtom = jotai.atom(248);
        mockLayout.fileExplorerWidthAtom = jotai.atom(260);
        mockLayout.model.vtabVisibleAtom = mockLayout.vtabVisibleAtom;
        mockLayout.model.fileExplorerVisibleAtom = mockLayout.fileExplorerVisibleAtom;
        mockLayout.model.vtabWidthAtom = mockLayout.vtabWidthAtom;
        mockLayout.model.fileExplorerWidthAtom = mockLayout.fileExplorerWidthAtom;
        mockLayout.model.getRightToolPanelMaxWidth = vi.fn(
            (
                windowWidth: number,
                vtabVisible: boolean,
                vtabWidth: number,
                fileExplorerVisible: boolean,
                fileExplorerWidth: number
            ) => windowWidth - (vtabVisible ? vtabWidth : 0) - (fileExplorerVisible ? fileExplorerWidth : 0) - 320
        );

        const markup = renderToStaticMarkup(<Workspace />);

        expect(mockLayout.model.getRightToolPanelMaxWidth).toHaveBeenCalledWith(1200, true, 248, true, 260);
        expect(markup).toContain('aria-label="Resize left" data-max="372"');
    });

    it("renders the collapsed toggle only when hidden and non-magnified", () => {
        mockLayout.rightToolPanelAtom = jotai.atom({
            ...DefaultRightToolPanelState,
            visible: false,
            openedTools: ["editor"],
            activeTool: "editor",
            magnified: true,
        });
        mockLayout.model.rightToolPanelAtom = mockLayout.rightToolPanelAtom;

        const hiddenMagnifiedMarkup = renderToStaticMarkup(<Workspace />);
        expect(hiddenMagnifiedMarkup).not.toContain('aria-label="Show right tool panel"');
        expect(hiddenMagnifiedMarkup).not.toContain('aria-label="Right tool panel"');
        expect(hiddenMagnifiedMarkup).not.toContain('aria-label="Magnified right tool panel"');

        mockLayout.rightToolPanelAtom = jotai.atom({
            ...DefaultRightToolPanelState,
            visible: false,
            openedTools: ["editor"],
            activeTool: "editor",
        });
        mockLayout.model.rightToolPanelAtom = mockLayout.rightToolPanelAtom;

        const collapsedMarkup = renderToStaticMarkup(<Workspace />);
        expect(collapsedMarkup).toContain('aria-label="Show right tool panel"');
        expect(collapsedMarkup).not.toContain('aria-label="Right tool panel"');

        const mainContentIndex = collapsedMarkup.indexOf("<main>Main Tab Content</main>");
        const collapsedToggleIndex = collapsedMarkup.indexOf('aria-label="Show right tool panel"');
        expect(mainContentIndex).toBeGreaterThanOrEqual(0);
        expect(collapsedToggleIndex).toBeGreaterThan(mainContentIndex);

        mockLayout.rightToolPanelAtom = jotai.atom({
            ...DefaultRightToolPanelState,
            openedTools: ["editor"],
            activeTool: "editor",
            magnified: true,
        });
        mockLayout.model.rightToolPanelAtom = mockLayout.rightToolPanelAtom;

        const magnifiedMarkup = renderToStaticMarkup(<Workspace />);
        expect(magnifiedMarkup).toContain('aria-label="Magnified right tool panel"');
        expect(magnifiedMarkup).toContain('aria-label="Exit magnified right tool panel"');
    });

    it("renders only the magnified overlay, not the normal right panel, while magnified", () => {
        mockLayout.rightToolPanelAtom = jotai.atom({
            ...DefaultRightToolPanelState,
            openedTools: ["editor"],
            activeTool: "editor",
            magnified: true,
        });
        mockLayout.model.rightToolPanelAtom = mockLayout.rightToolPanelAtom;

        const markup = renderToStaticMarkup(<Workspace />);

        expect(markup).toContain('aria-label="Magnified right tool panel"');
        expect(markup).not.toContain('aria-label="Right tool panel"');
        expect(markup).not.toContain('aria-label="Resize left"');
        expect(markup).not.toContain('aria-label="Show right tool panel"');
    });

    it("clears right tool focus when focus returns to the main tab content", () => {
        renderToStaticMarkup(<Workspace />);

        const tabContentProps = mockLayout.tabContentMock.mock.calls[0][0];
        expect(tabContentProps.onFocusCapture).toBeTypeOf("function");

        tabContentProps.onFocusCapture();

        expect(mockLayout.model.setRightToolPanelFocused).toHaveBeenCalledWith(false);
    });

    it("clears stale right tool focus when TopBar chrome is clicked before Cmd+M fallback", () => {
        renderToStaticMarkup(<Workspace />);

        expect(mockLayout.topBarProps.onPointerDownCapture).toBeTypeOf("function");

        mockLayout.topBarProps.onPointerDownCapture({
            target: {
                closest: () => null,
            },
        });

        expect(mockLayout.model.setRightToolPanelFocused).toHaveBeenCalledWith(false);
    });

    it("previews right tool width during drag and persists only when resize ends", () => {
        renderToStaticMarkup(<Workspace />);

        expect(mockLayout.rightResizeHandleProps.onResize).toBeTypeOf("function");
        expect(mockLayout.rightResizeHandleProps.onResizeEnd).toBeTypeOf("function");

        mockLayout.rightResizeHandleProps.onResize(430);
        mockLayout.rightResizeHandleProps.onResize(440);
        mockLayout.rightResizeHandleProps.onResizeEnd(440);

        expect(mockLayout.model.previewRightToolPanelWidth).toHaveBeenCalledTimes(2);
        expect(mockLayout.model.previewRightToolPanelWidth).toHaveBeenNthCalledWith(1, 430);
        expect(mockLayout.model.previewRightToolPanelWidth).toHaveBeenNthCalledWith(2, 440);
        expect(mockLayout.model.setRightToolPanelWidth).toHaveBeenCalledTimes(1);
        expect(mockLayout.model.setRightToolPanelWidth).toHaveBeenCalledWith(440);
    });
});
