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
        leftPanelAtom: null as jotai.PrimitiveAtom<any>,
        codeReviewVisibleAtom: null as jotai.PrimitiveAtom<boolean>,
        codeReviewWideAtom: null as jotai.PrimitiveAtom<boolean>,
        rightToolPanelAtom: null as jotai.PrimitiveAtom<RightToolPanelState>,
        tabContentMock: null as any,
        topBarProps: null as any,
        rightResizeHandleProps: null as any,
        observabilityProps: null as any,
        model: null as any,
    };
    return state;
});

const mockFocusManager = vi.hoisted(() => ({
    requestNodeFocus: vi.fn(),
    requestRightToolPanelFocus: vi.fn(),
}));

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
        getApi: () => ({
            getHomeDir: () => "/repo",
        }),
        getSettingsKeyAtom: () => mockLayout.tabBarSettingAtom,
    };
});

vi.mock("@/app/workspace/workspace-layout-model", async () => {
    const jotaiActual = await vi.importActual<typeof import("jotai")>("jotai");
    mockLayout.leftPanelAtom = jotaiActual.atom({ visible: false, mode: "files", width: 260 });
    mockLayout.codeReviewVisibleAtom = jotaiActual.atom(true);
    mockLayout.codeReviewWideAtom = jotaiActual.atom(false);
    mockLayout.rightToolPanelAtom = jotaiActual.atom({
        ...defaultRightToolPanelState,
        width: 420,
        openedTools: ["codeReview"],
        activeTool: "codeReview",
    });
    mockLayout.model = {
        leftPanelAtom: mockLayout.leftPanelAtom,
        codeReviewVisibleAtom: mockLayout.codeReviewVisibleAtom,
        codeReviewWideAtom: mockLayout.codeReviewWideAtom,
        rightToolPanelAtom: mockLayout.rightToolPanelAtom,
        getLeftPanelStateForWorkspace: vi.fn((_workspaceId: string, state: any) => state),
        getRightToolPanelStateForWorkspace: vi.fn((_workspaceId: string, state: RightToolPanelState) => state),
        hydrateLeftPanelFromWorkspace: vi.fn(),
        hydrateRightToolPanelFromWorkspace: vi.fn(),
        getLeftPanelMinWidth: () => 180,
        getLeftPanelMaxWidth: () => 500,
        getRightToolPanelMaxWidth: () => 840,
        previewLeftPanelWidth: vi.fn(),
        setLeftPanelWidth: vi.fn(),
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

vi.mock("@/app/store/focusManager", () => ({
    FocusManager: {
        getInstance: () => mockFocusManager,
    },
}));

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

vi.mock("@/app/righteditor/right-editor-workbench", () => ({
    RightEditorWorkbench: () => <div>Right Editor Workbench</div>,
}));

vi.mock("@/app/observability/observability-panel", () => ({
    ObservabilityPanel: (props: { sessionId?: string }) => {
        mockLayout.observabilityProps = props;
        return <div aria-label="Agent Observability" data-session-id={props.sessionId} />;
    },
}));

vi.mock("@/app/topbar/topbar", () => ({
    TopBar: (props: { onPointerDownCapture?: React.PointerEventHandler<HTMLDivElement> }) => {
        mockLayout.topBarProps = props;
        return (
            <div data-testid="topbar" onPointerDownCapture={props.onPointerDownCapture}>
                <i className="fa-table-columns" />
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
        jotai.getDefaultStore().set(mockLayout.staticTabIdAtom, "tab-a");
        mockLayout.leftPanelAtom = jotai.atom({ visible: false, mode: "files", width: 260 });
        mockLayout.model.leftPanelAtom = mockLayout.leftPanelAtom;
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
        mockLayout.model.getLeftPanelStateForWorkspace = vi.fn((_workspaceId: string, state: any) => state);
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
        mockLayout.observabilityProps = null;
    });

    it("renders the right tool panel in workspace chrome instead of the legacy code review PanelGroup", () => {
        const markup = renderToStaticMarkup(<Workspace />);

        expect(mockLayout.model.hydrateRightToolPanelFromWorkspace).not.toHaveBeenCalled();
        expect(markup).toContain('aria-label="Right tool panel"');
        expect(markup).toContain("width:420px");
        expect(markup).toContain('aria-label="Select Code Review"');
        expect(markup).toContain("Git Review Sidebar");
        expect(markup).toContain('aria-label="Resize left"');
        expect(markup).not.toContain("data-legacy-panel-group");
        expect(markup).not.toContain("data-legacy-resize-handle");
    });

    it.each([
        ["files", "File Explorer"],
        ["sessions", ""],
        ["terminals", "Terminal List"],
    ])("renders one left panel slot for %s", (mode, content) => {
        mockLayout.leftPanelAtom = jotai.atom({ visible: true, mode, width: 280 });
        mockLayout.model.leftPanelAtom = mockLayout.leftPanelAtom;

        const markup = renderToStaticMarkup(<Workspace terminalList={<div>Terminal List</div>} />);

        expect(markup).toContain("width:280px");
        if (content) {
            expect(markup).toContain(content);
        }
        expect(markup.match(/aria-label="Resize right"/g) ?? []).toHaveLength(1);
    });

    it.each([
        ["files", "File Explorer"],
        ["sessions", ""],
        ["terminals", "Terminal List"],
    ])("keeps the %s left panel mounted without an active tab", (mode, content) => {
        jotai.getDefaultStore().set(mockLayout.staticTabIdAtom, "");
        mockLayout.leftPanelAtom = jotai.atom({ visible: true, mode, width: 280 });
        mockLayout.model.leftPanelAtom = mockLayout.leftPanelAtom;

        const markup = renderToStaticMarkup(<Workspace terminalList={<div>Terminal List</div>} />);

        expect(markup).toContain("width:280px");
        if (content) {
            expect(markup).toContain(content);
        }
        expect(markup.match(/aria-label="Resize right"/g) ?? []).toHaveLength(1);
        expect(markup).toContain("No Active Tab");
    });

    it("does not render or reserve the left panel slot while hidden", () => {
        const markup = renderToStaticMarkup(<Workspace />);

        expect(markup).not.toContain("File Explorer");
        expect(markup).not.toContain("Agent Sessions");
        expect(markup).not.toContain("Terminal List");
        expect(markup).not.toContain('aria-label="Resize right"');
    });

    it("does not treat an unknown left panel mode as terminals", () => {
        mockLayout.leftPanelAtom = jotai.atom({ visible: true, mode: "unknown", width: 280 });
        mockLayout.model.leftPanelAtom = mockLayout.leftPanelAtom;

        const markup = renderToStaticMarkup(<Workspace />);

        expect(markup).not.toContain("Terminal List");
    });

    it("does not derive observability session scope from legacy Agent blocks", () => {
        mockLayout.rightToolPanelAtom = jotai.atom({
            ...DefaultRightToolPanelState,
            openedTools: ["observability"],
            activeTool: "observability",
        });
        mockLayout.model.rightToolPanelAtom = mockLayout.rightToolPanelAtom;

        const markup = renderToStaticMarkup(<Workspace />);

        expect(markup).toContain('aria-label="Agent Observability"');
        expect(mockLayout.observabilityProps).toMatchObject({
            sessionId: undefined,
        });
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

    it("keeps the magnified right tool overlay outside the tab-keyed boundary", () => {
        mockLayout.rightToolPanelAtom = jotai.atom({
            ...DefaultRightToolPanelState,
            openedTools: ["codeReview"],
            activeTool: "codeReview",
            magnified: true,
        });
        mockLayout.model.rightToolPanelAtom = mockLayout.rightToolPanelAtom;

        const markup = renderToStaticMarkup(<Workspace />);
        const boundaryStart = markup.indexOf('data-workspace-error-boundary-start="true"');
        const boundaryEnd = markup.indexOf('data-workspace-error-boundary-end="true"');
        const overlayIndex = markup.indexOf('aria-label="Magnified right tool panel"');
        const boundaryContent = markup.slice(boundaryStart, boundaryEnd);

        expect(boundaryStart).toBeGreaterThanOrEqual(0);
        expect(boundaryEnd).toBeGreaterThan(boundaryStart);
        expect(overlayIndex).toBeGreaterThan(boundaryEnd);
        expect(boundaryContent).toContain("<main>Main Tab Content</main>");
        expect(boundaryContent).not.toContain('aria-label="Magnified right tool panel"');
        expect(boundaryContent).not.toContain('aria-label="Exit magnified right tool panel"');
        expect(boundaryContent).not.toContain("Git Review Sidebar");
        expect(markup).toContain('aria-label="Magnified right tool panel"');
        expect(markup).toContain('aria-label="Exit magnified right tool panel"');
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
        expect(markup).not.toContain('aria-label="Show right tool panel"');
        expect(markup).toContain("fa-table-columns");
    });

    it("renders ws-b left panel content and width on the first frame while the singleton still holds ws-a", () => {
        mockLayout.leftPanelAtom = jotai.atom({ visible: true, mode: "sessions", width: 300 });
        mockLayout.model.leftPanelAtom = mockLayout.leftPanelAtom;
        jotai.getDefaultStore().set(mockLayout.workspaceAtom, {
            otype: "workspace",
            oid: "ws-b",
            version: 1,
            meta: {},
            tabids: ["tab-b"],
            activetabid: "tab-b",
        } as Workspace);
        mockLayout.model.getLeftPanelStateForWorkspace = vi.fn((workspaceId: string, state: any) =>
            workspaceId === "ws-b" ? { visible: true, mode: "terminals", width: 340 } : state
        );

        const markup = renderToStaticMarkup(<Workspace terminalList={<div>Terminal List</div>} />);

        expect(markup).toContain("width:340px");
        expect(markup).toContain("Terminal List");
        expect(markup).not.toContain("Agent Sessions");
    });

    it("renders the TopBar right panel button inactive on the first ws-b render when ws-a left it visible", () => {
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

        expect(markup).toContain("fa-table-columns");
        expect(markup).not.toContain("text-accent bg-white/10");
    });

    it("clamps the right tool resize budget after visible left panels and the main content floor", () => {
        mockLayout.leftPanelAtom = jotai.atom({ visible: true, mode: "files", width: 260 });
        mockLayout.model.leftPanelAtom = mockLayout.leftPanelAtom;
        mockLayout.model.getRightToolPanelMaxWidth = vi.fn(
            (windowWidth: number, leftPanelVisible: boolean, leftPanelWidth: number) =>
                windowWidth - (leftPanelVisible ? leftPanelWidth : 0) - 320
        );

        const markup = renderToStaticMarkup(<Workspace />);

        expect(mockLayout.model.getRightToolPanelMaxWidth).toHaveBeenCalledWith(1200, true, 260);
        expect(markup).toContain('aria-label="Resize left" data-max="620"');
    });

    it("does not render an in-content collapsed toggle when the panel is hidden", () => {
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
        expect(collapsedMarkup).not.toContain('aria-label="Show right tool panel"');
        expect(collapsedMarkup).not.toContain('aria-label="Right tool panel"');

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
        expect(mockFocusManager.requestNodeFocus).toHaveBeenCalledTimes(1);
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
        expect(mockFocusManager.requestNodeFocus).toHaveBeenCalledTimes(1);
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
