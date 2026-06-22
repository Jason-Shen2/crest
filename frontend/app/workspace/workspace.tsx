// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ErrorBoundary } from "@/app/element/errorboundary";
import { CenteredDiv } from "@/app/element/quickelems";
import { FileExplorer } from "@/app/fileexplorer/file-explorer";
import { ModalsRenderer } from "@/app/modals/modalsrenderer";
import { NotificationToastStacker } from "@/app/notifications/notification-toast";
import { NotificationsModel } from "@/app/notifications/notifications-model";
import { TabBar } from "@/app/tab/tabbar";
import { TabContent } from "@/app/tab/tabcontent";
import { VTabBar } from "@/app/tab/vtabbar";
import { TopBar } from "@/app/topbar/topbar";
import { ResizeHandle } from "@/app/workspace/resize-handle";
import {
    RightToolPanel,
    RightToolPanelMagnifiedOverlay,
} from "@/app/workspace/right-tool-panel";
import { MinRightToolPanelWidth } from "@/app/workspace/right-tool-panel-state";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { atoms, getSettingsKeyAtom } from "@/store/global";
import { isMacOS } from "@/util/platformutil";
import { useAtomValue } from "jotai";
import type { PointerEvent } from "react";
import { memo, useCallback, useEffect } from "react";

const RightToolPanelRootSelector = '[data-right-tool-panel-root="true"]';

type ClosestEventTarget = EventTarget & {
    closest?: (selector: string) => Element | null;
};

export function shouldClearRightToolPanelFocusForTarget(target: EventTarget | null): boolean {
    const closest = (target as ClosestEventTarget)?.closest;
    if (typeof closest !== "function") {
        return true;
    }
    return closest.call(target, RightToolPanelRootSelector) == null;
}

// Workspace layout — warp parity (see app/src/workspace/view.rs:19448
// `render_panels`).  Left panels are absolute-px widths in a flex row;
// when hidden they're absent from the row entirely (no collapse animation,
// no defaultSize negotiation).  The center "content" column is flex-1
// so it absorbs all remaining space — warp uses `Shrinkable::new(1.0, ...)`
// on the terminal_view for the same purpose (view.rs:19503).
const WorkspaceElem = memo(() => {
    const workspaceLayoutModel = WorkspaceLayoutModel.getInstance();
    const tabId = useAtomValue(atoms.staticTabId);
    const ws = useAtomValue(atoms.workspace);

    useEffect(() => {
        // Background subscription kept so completions that happen before
        // the notifications panel is first opened still surface as toasts.
        NotificationsModel.getInstance().ensureSubscribed();
    }, []);

    const tabBarPosition = useAtomValue(getSettingsKeyAtom("app:tabbar")) ?? "top";
    const showLeftTabBar = tabBarPosition === "left";
    const vtabVisible = useAtomValue(workspaceLayoutModel.vtabVisibleAtom);
    const fileExplorerVisible = useAtomValue(workspaceLayoutModel.fileExplorerVisibleAtom);
    const vtabWidth = useAtomValue(workspaceLayoutModel.vtabWidthAtom);
    const fileExplorerWidth = useAtomValue(workspaceLayoutModel.fileExplorerWidthAtom);
    const hydratedRightToolPanelState = useAtomValue(workspaceLayoutModel.rightToolPanelAtom);
    const rightToolPanelState = workspaceLayoutModel.getRightToolPanelStateForWorkspace(
        ws.oid,
        hydratedRightToolPanelState
    );

    // VTab visibility derives from the tabbar-position setting — same
    // semantics as the legacy model.  Setting persists at the app level;
    // we mirror it into our visibility atom so the toolbar toggle (which
    // also flips this atom) stays in sync.
    useEffect(() => {
        workspaceLayoutModel.setVTabVisible(showLeftTabBar);
    }, [showLeftTabBar, workspaceLayoutModel]);

    useEffect(() => {
        workspaceLayoutModel.hydrateRightToolPanelFromWorkspace();
    }, [workspaceLayoutModel, ws.oid]);

    // ResizeHandle reads `maxFn()` on every pointermove so a window
    // resize mid-drag updates the bound (warp's `with_bounds_callback`).
    // Each closure also captures the *other* panel's visibility/width so
    // shrinking the FE doesn't let the VTab steal the budget.
    const vtabMaxFn = useCallback(
        () => workspaceLayoutModel.getVTabMaxWidth(window.innerWidth, fileExplorerVisible, fileExplorerWidth),
        [workspaceLayoutModel, fileExplorerVisible, fileExplorerWidth]
    );
    const fileExplorerMaxFn = useCallback(
        () => workspaceLayoutModel.getFileExplorerMaxWidth(window.innerWidth, vtabVisible, vtabWidth),
        [workspaceLayoutModel, vtabVisible, vtabWidth]
    );

    const onVTabResize = useCallback((px: number) => workspaceLayoutModel.setVTabWidth(px), [workspaceLayoutModel]);
    const onFileExplorerResize = useCallback(
        (px: number) => workspaceLayoutModel.setFileExplorerWidth(px),
        [workspaceLayoutModel]
    );
    const rightToolPanelMaxFn = useCallback(
        () =>
            workspaceLayoutModel.getRightToolPanelMaxWidth(
                window.innerWidth,
                vtabVisible,
                vtabWidth,
                fileExplorerVisible,
                fileExplorerWidth
            ),
        [workspaceLayoutModel, vtabVisible, vtabWidth, fileExplorerVisible, fileExplorerWidth]
    );
    const onRightToolPanelResize = useCallback(
        (px: number) => workspaceLayoutModel.previewRightToolPanelWidth(px),
        [workspaceLayoutModel]
    );
    const onRightToolPanelResizeEnd = useCallback(
        (px: number) => workspaceLayoutModel.setRightToolPanelWidth(px),
        [workspaceLayoutModel]
    );
    const onRightToolPanelHide = useCallback(
        () => workspaceLayoutModel.setRightToolPanelVisible(false),
        [workspaceLayoutModel]
    );
    const onRightToolPanelFocus = useCallback(
        () => workspaceLayoutModel.setRightToolPanelFocused(true),
        [workspaceLayoutModel]
    );
    const onMainWorkspaceFocus = useCallback(
        () => workspaceLayoutModel.setRightToolPanelFocused(false),
        [workspaceLayoutModel]
    );
    const onWorkspaceChromePointerDownCapture = useCallback(
        (event: PointerEvent<HTMLDivElement>) => {
            if (!shouldClearRightToolPanelFocusForTarget(event.target)) return;
            workspaceLayoutModel.setRightToolPanelFocused(false);
        },
        [workspaceLayoutModel]
    );
    const onRightToolPanelExitMagnified = useCallback(
        () => workspaceLayoutModel.setRightToolPanelMagnified(false),
        [workspaceLayoutModel]
    );
    const showRightToolPanelLayout = rightToolPanelState.visible && !rightToolPanelState.magnified;

    return (
        <div
            className="flex flex-col w-full flex-grow overflow-hidden"
            onPointerDownCapture={onWorkspaceChromePointerDownCapture}
        >
            <TopBar onPointerDownCapture={onWorkspaceChromePointerDownCapture} />
            {!showLeftTabBar && <TabBar key={ws.oid} workspace={ws} noTabs={false} />}
            <div className="flex flex-row flex-grow overflow-hidden min-h-0">
                {/* Left panel 1: vertical tab bar.  Absent from the
                        flex row when hidden — warp pattern (view.rs:19466
                        `if vertical_tabs_active { add child }`). */}
                {vtabVisible && showLeftTabBar && (
                    <>
                        <div className="shrink-0 h-full overflow-hidden" style={{ width: `${vtabWidth}px` }}>
                            <VTabBar workspace={ws} />
                        </div>
                        <ResizeHandle
                            width={vtabWidth}
                            min={workspaceLayoutModel.getVTabMinWidth()}
                            maxFn={vtabMaxFn}
                            onResize={onVTabResize}
                            side="right"
                        />
                    </>
                )}

                {/* Left panel 2: file explorer.  Same pattern. */}
                {fileExplorerVisible && (
                    <>
                        <div className="shrink-0 h-full overflow-hidden" style={{ width: `${fileExplorerWidth}px` }}>
                            {tabId !== "" && <FileExplorer />}
                        </div>
                        <ResizeHandle
                            width={fileExplorerWidth}
                            min={workspaceLayoutModel.getFileExplorerMinWidth()}
                            maxFn={fileExplorerMaxFn}
                            onResize={onFileExplorerResize}
                            side="right"
                        />
                    </>
                )}

                {/* Content column — flex-1 absorbs the remaining width
                        on window resize.  warp: `Shrinkable::new(1.0, terminal_view)`
                        in render_panels (view.rs:19503). */}
                <div className="flex-1 min-w-0 h-full flex flex-col overflow-hidden">
                    {tabId === "" ? (
                        <CenteredDiv>No Active Tab</CenteredDiv>
                    ) : (
                        <div className="relative flex-1 min-h-0 w-full">
                            <ErrorBoundary key={tabId}>
                                <div className="relative flex flex-row w-full h-full overflow-hidden">
                                    <TabContent
                                        key={tabId}
                                        tabId={tabId}
                                        noTopPadding={showLeftTabBar && isMacOS()}
                                        onFocusCapture={onMainWorkspaceFocus}
                                    />
                                </div>
                            </ErrorBoundary>
                        </div>
                    )}
                </div>
                {showRightToolPanelLayout ? (
                    <>
                        <ResizeHandle
                            width={rightToolPanelState.width}
                            min={MinRightToolPanelWidth}
                            maxFn={rightToolPanelMaxFn}
                            onResize={onRightToolPanelResize}
                            onResizeEnd={onRightToolPanelResizeEnd}
                            side="left"
                        />
                        <RightToolPanel
                            state={rightToolPanelState}
                            onOpenTool={(tool) => workspaceLayoutModel.openRightTool(tool)}
                            onSelectTool={(tool) => workspaceLayoutModel.selectRightTool(tool)}
                            onCloseTool={(tool) => workspaceLayoutModel.closeRightTool(tool)}
                            onHide={onRightToolPanelHide}
                            onFocusPanel={onRightToolPanelFocus}
                            onBlurPanel={onMainWorkspaceFocus}
                        />
                    </>
                ) : null}
                <RightToolPanelMagnifiedOverlay
                    state={rightToolPanelState}
                    onOpenTool={(tool) => workspaceLayoutModel.openRightTool(tool)}
                    onSelectTool={(tool) => workspaceLayoutModel.selectRightTool(tool)}
                    onCloseTool={(tool) => workspaceLayoutModel.closeRightTool(tool)}
                    onFocusPanel={onRightToolPanelFocus}
                    onBlurPanel={onMainWorkspaceFocus}
                    onExit={onRightToolPanelExitMagnified}
                />
                <ModalsRenderer />
            </div>
            <NotificationToastStacker />
        </div>
    );
});

WorkspaceElem.displayName = "WorkspaceElem";

export { WorkspaceElem as Workspace };
