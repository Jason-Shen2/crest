// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ErrorBoundary } from "@/app/element/errorboundary";
import { CenteredDiv } from "@/app/element/quickelems";
import { ModalsRenderer } from "@/app/modals/modalsrenderer";
import { NotificationToastStacker } from "@/app/notifications/notification-toast";
import { NotificationsModel } from "@/app/notifications/notifications-model";
import { StatusBar } from "@/app/statusbar/status-bar";
import { FocusManager } from "@/app/store/focusManager";
import { TabContent } from "@/app/tab/tabcontent";
import { TopBar } from "@/app/topbar/topbar";
import { ResizeHandle } from "@/app/workspace/resize-handle";
import { RightToolPanel, RightToolPanelMagnifiedOverlay } from "@/app/workspace/right-tool-panel";
import { MinRightToolPanelWidth } from "@/app/workspace/right-tool-panel-state";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { WorkspaceLeftPanel } from "@/app/workspace/workspace-left-panel";
import { atoms } from "@/store/global";
import { isMacOS } from "@/util/platformutil";
import { useAtomValue } from "jotai";
import type { PointerEvent, ReactNode } from "react";
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
// `render_panels`). The left panel has an absolute-px width in a flex row;
// when hidden it's absent from the row entirely (no collapse animation,
// no defaultSize negotiation).  The center "content" column is flex-1
// so it absorbs all remaining space — warp uses `Shrinkable::new(1.0, ...)`
// on the terminal_view for the same purpose (view.rs:19503).
const WorkspaceElem = memo(({ terminalList }: { terminalList?: ReactNode }) => {
    const workspaceLayoutModel = WorkspaceLayoutModel.getInstance();
    const tabId = useAtomValue(atoms.staticTabId);
    const ws = useAtomValue(atoms.workspace);

    useEffect(() => {
        // Background subscription kept so completions that happen before
        // the notifications panel is first opened still surface as toasts.
        NotificationsModel.getInstance().ensureSubscribed();
    }, []);

    const hydratedLeftPanel = useAtomValue(workspaceLayoutModel.leftPanelAtom);
    const leftPanel = workspaceLayoutModel.getLeftPanelStateForWorkspace(ws.oid, hydratedLeftPanel);
    const hydratedRightToolPanelState = useAtomValue(workspaceLayoutModel.rightToolPanelAtom);
    const rightToolPanelState = workspaceLayoutModel.getRightToolPanelStateForWorkspace(
        ws.oid,
        hydratedRightToolPanelState
    );

    useEffect(() => {
        workspaceLayoutModel.hydrateLeftPanelFromWorkspace();
        workspaceLayoutModel.hydrateRightToolPanelFromWorkspace();
    }, [workspaceLayoutModel, ws.oid]);

    const leftPanelMaxFn = useCallback(
        () => workspaceLayoutModel.getLeftPanelMaxWidth(window.innerWidth),
        [workspaceLayoutModel]
    );
    const onLeftPanelResize = useCallback(
        (px: number) => workspaceLayoutModel.previewLeftPanelWidth(px),
        [workspaceLayoutModel]
    );
    const onLeftPanelResizeEnd = useCallback(
        (px: number) => workspaceLayoutModel.setLeftPanelWidth(px),
        [workspaceLayoutModel]
    );
    const rightToolPanelMaxFn = useCallback(
        () => workspaceLayoutModel.getRightToolPanelMaxWidth(window.innerWidth, leftPanel.visible, leftPanel.width),
        [workspaceLayoutModel, leftPanel.visible, leftPanel.width]
    );
    const onRightToolPanelResize = useCallback(
        (px: number) => workspaceLayoutModel.previewRightToolPanelWidth(px),
        [workspaceLayoutModel]
    );
    const onRightToolPanelResizeEnd = useCallback(
        (px: number) => workspaceLayoutModel.setRightToolPanelWidth(px),
        [workspaceLayoutModel]
    );
    const onRightToolPanelMagnify = useCallback(
        () => workspaceLayoutModel.setRightToolPanelMagnified(!rightToolPanelState.magnified),
        [workspaceLayoutModel, rightToolPanelState.magnified]
    );
    const onRightToolPanelFocus = useCallback(() => {
        FocusManager.getInstance().requestRightToolPanelFocus();
        workspaceLayoutModel.setRightToolPanelFocused(true);
    }, [workspaceLayoutModel]);
    const onMainWorkspaceFocus = useCallback(() => {
        FocusManager.getInstance().requestNodeFocus();
        workspaceLayoutModel.setRightToolPanelFocused(false);
    }, [workspaceLayoutModel]);
    const onWorkspaceChromePointerDownCapture = useCallback(
        (event: PointerEvent<HTMLDivElement>) => {
            if (!shouldClearRightToolPanelFocusForTarget(event.target)) return;
            FocusManager.getInstance().requestNodeFocus();
            workspaceLayoutModel.setRightToolPanelFocused(false);
        },
        [workspaceLayoutModel]
    );
    const onRightToolPanelExitMagnified = useCallback(
        () => workspaceLayoutModel.setRightToolPanelMagnified(false),
        [workspaceLayoutModel]
    );
    const showRightToolPanelLayout = rightToolPanelState.visible;

    return (
        <div
            className="flex flex-col w-full flex-grow overflow-hidden"
            onPointerDownCapture={onWorkspaceChromePointerDownCapture}
        >
            <TopBar workspace={ws} onPointerDownCapture={onWorkspaceChromePointerDownCapture} />
            <div className="relative flex flex-row flex-grow overflow-hidden min-h-0">
                {leftPanel.visible && (
                    <>
                        <div className="shrink-0 h-full overflow-hidden" style={{ width: `${leftPanel.width}px` }}>
                            <WorkspaceLeftPanel
                                mode={leftPanel.mode}
                                terminalList={terminalList}
                                layoutModel={workspaceLayoutModel}
                            />
                        </div>
                        <ResizeHandle
                            width={leftPanel.width}
                            min={workspaceLayoutModel.getLeftPanelMinWidth()}
                            maxFn={leftPanelMaxFn}
                            onResize={onLeftPanelResize}
                            onResizeEnd={onLeftPanelResizeEnd}
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
                                        noTopPadding={isMacOS()}
                                        onFocusCapture={onMainWorkspaceFocus}
                                    />
                                </div>
                            </ErrorBoundary>
                        </div>
                    )}
                </div>
                {showRightToolPanelLayout ? (
                    <>
                        {!rightToolPanelState.magnified ? (
                            <ResizeHandle
                                width={rightToolPanelState.width}
                                min={MinRightToolPanelWidth}
                                maxFn={rightToolPanelMaxFn}
                                onResize={onRightToolPanelResize}
                                onResizeEnd={onRightToolPanelResizeEnd}
                                side="left"
                            />
                        ) : null}
                        <RightToolPanel
                            state={rightToolPanelState}
                            sessionId={undefined}
                            onOpenTool={(tool) => workspaceLayoutModel.openRightTool(tool)}
                            onSelectTool={(tool) => workspaceLayoutModel.selectRightTool(tool)}
                            onCloseTool={(tool) => workspaceLayoutModel.closeRightTool(tool)}
                            onMagnify={onRightToolPanelMagnify}
                            onFocusPanel={onRightToolPanelFocus}
                            onBlurPanel={onMainWorkspaceFocus}
                        />
                    </>
                ) : null}
                <RightToolPanelMagnifiedOverlay state={rightToolPanelState} onExit={onRightToolPanelExitMagnified} />
                <ModalsRenderer />
            </div>
            <NotificationToastStacker />
            <StatusBar />
        </div>
    );
});

WorkspaceElem.displayName = "WorkspaceElem";

export { WorkspaceElem as Workspace };
