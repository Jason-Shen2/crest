// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// WorkspaceLayoutModel — owns visibility + px width for the two left
// panels (VTabBar + FileExplorer).  Mirrors warp's pattern (LeftPanelView
// + ResizableData / WindowSnapshot in app/src/workspace/view/left_panel.rs
// and app/src/terminal/resizable_data.rs):
//
//   * Width is stored as a single px number — never converted to %.
//     Warp: `resizable_state_handle(DEFAULT_LEFT_PANEL_WIDTH)` keyed by
//     `ModalType::LeftPanelWidth`, restored from WindowSnapshot.
//   * Visibility is a bool.  When false, the panel is simply absent from
//     the flex row in workspace.tsx — no collapse, no animation, no
//     defaultSize fight.  Warp: `if !pane_group.left_panel_open { skip }`.
//   * Width is preserved across hide/show — warp's `toggle_left_panel`
//     (view.rs:8004-8061) keeps the previous px in ResizableData even
//     while the panel is closed, so reopen restores it exactly.
//   * Window resize doesn't touch widths — the content panel (flex-1)
//     absorbs the delta.  Warp does the same: `Shrinkable::new(1.0, ...)`
//     on the terminal_view in render_panels (view.rs:19503).
//
// Persistence cadence: visibility persists immediately on toggle; widths
// persist debounced on drag (300 ms idle) so a slow drag doesn't fire
// dozens of meta writes.

import { globalStore } from "@/app/store/jotaiStore";
import { isBuilderWindow } from "@/app/store/windowtype";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import { atoms, getOrefMetaKeyAtom, getSettingsKeyAtom, refocusNode } from "@/store/global";
import * as jotai from "jotai";
import { debounce } from "lodash-es";
import type { RightToolId, RightToolPanelState } from "./right-tool-panel-state";
import {
    closeRightTool,
    DefaultRightToolPanelState,
    makePersistedRightToolPanelState,
    normalizeRightToolPanelState,
    openRightTool,
    selectRightTool,
    setRightToolPanelWidth as setRightToolPanelStateWidth,
} from "./right-tool-panel-state";

// Width constants — warp parity.
//   warp/drive/panel.rs:38           MIN_SIDEBAR_WIDTH      = 250.
//   warp/drive/panel.rs:39           MAX_SIDEBAR_WIDTH_RATIO = 0.75
//   warp/terminal/resizable_data.rs:16  DEFAULT_LEFT_PANEL_WIDTH = 240.
// crest tweaks: VTab+FE coexist (warp has one panel with view-switcher),
// so we give the FE a slightly tighter max and the VTab a narrower band
// so the two together can't crowd the terminal off the screen.
const VTabBar_DefaultWidth = 248;
const VTabBar_MinWidth = 200;
const VTabBar_MaxWidth = 360;

const FileExplorer_DefaultWidth = 260;
const FileExplorer_MinWidth = 180;
const FileExplorer_MaxWidthRatio = 0.5;

// Floor for the content panel — together both side panels can never
// take more than (window - this) px.  Matches the spirit of warp's
// max_width clamp without needing a runtime window-size callback.
const Content_MinWidth = 320;
const RightToolPanelWindowWidthFallback = 1200;
export const RightToolPanelMetaKey = "layout:righttoolpanel";

function clamp(value: number, min: number, max: number): number {
    if (max < min) return min;
    return Math.max(min, Math.min(value, max));
}

function getRightToolPanelWindowWidth(): number {
    return globalThis.window?.innerWidth ?? RightToolPanelWindowWidthFallback;
}

class WorkspaceLayoutModel {
    private static instance: WorkspaceLayoutModel | null = null;

    // ---- Source-of-truth atoms ----
    // Visibility booleans — toggle flips them, view skips render when false.
    vtabVisibleAtom: jotai.PrimitiveAtom<boolean>;
    fileExplorerVisibleAtom: jotai.PrimitiveAtom<boolean>;
    // Widths in px.  Workspace.tsx reads these via useAtomValue.
    vtabWidthAtom: jotai.PrimitiveAtom<number>;
    fileExplorerWidthAtom: jotai.PrimitiveAtom<number>;
    // Right-side code-review panel — orthogonal to the two left panels.
    codeReviewVisibleAtom: jotai.PrimitiveAtom<boolean>;
    codeReviewWideAtom: jotai.PrimitiveAtom<boolean>;
    // Legacy: AI panel was removed but external callers still import the
    // atom + setter.  Keep them as harmless no-ops.
    panelVisibleAtom: jotai.PrimitiveAtom<boolean>;
    rightToolPanelAtom: jotai.PrimitiveAtom<RightToolPanelState>;

    private debouncedPersistVTabWidth: () => void;
    private debouncedPersistFileExplorerWidth: () => void;
    private hydratedRightToolPanelWorkspaceId = "";

    private constructor() {
        this.vtabVisibleAtom = jotai.atom(false);
        this.fileExplorerVisibleAtom = jotai.atom(true);
        this.vtabWidthAtom = jotai.atom(VTabBar_DefaultWidth);
        this.fileExplorerWidthAtom = jotai.atom(FileExplorer_DefaultWidth);
        this.codeReviewVisibleAtom = jotai.atom(false);
        this.codeReviewWideAtom = jotai.atom(false);
        this.panelVisibleAtom = jotai.atom(false);
        this.rightToolPanelAtom = jotai.atom({ ...DefaultRightToolPanelState });

        this.initializeFromMeta();

        this.debouncedPersistVTabWidth = debounce(() => {
            if (!globalStore.get(this.vtabVisibleAtom)) return;
            const width = globalStore.get(this.vtabWidthAtom);
            if (width <= 0) return;
            try {
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("workspace", this.getWorkspaceId()),
                    meta: { "layout:vtabbarwidth": width },
                });
            } catch (e) {
                console.warn("Failed to persist vtabbar width:", e);
            }
        }, 300);

        this.debouncedPersistFileExplorerWidth = debounce(() => {
            if (!globalStore.get(this.fileExplorerVisibleAtom)) return;
            const width = globalStore.get(this.fileExplorerWidthAtom);
            if (width <= 0) return;
            try {
                RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("workspace", this.getWorkspaceId()),
                    meta: { "layout:fileexplorerwidth": width },
                });
            } catch (e) {
                console.warn("Failed to persist file explorer width:", e);
            }
        }, 300);
    }

    static getInstance(): WorkspaceLayoutModel {
        if (!WorkspaceLayoutModel.instance) {
            WorkspaceLayoutModel.instance = new WorkspaceLayoutModel();
        }
        return WorkspaceLayoutModel.instance;
    }

    static resetInstance(): void {
        WorkspaceLayoutModel.instance = null;
    }

    // ---- Meta / persistence helpers ----

    private getWorkspaceId(): string {
        return globalStore.get(atoms.workspace)?.oid ?? "";
    }

    private getVTabBarWidthAtom(): jotai.Atom<number> {
        return getOrefMetaKeyAtom(WOS.makeORef("workspace", this.getWorkspaceId()), "layout:vtabbarwidth");
    }

    private getFileExplorerVisibleAtom(): jotai.Atom<boolean> {
        return getOrefMetaKeyAtom(WOS.makeORef("workspace", this.getWorkspaceId()), "layout:fileexplorervisible");
    }

    private getFileExplorerWidthAtom(): jotai.Atom<number> {
        return getOrefMetaKeyAtom(WOS.makeORef("workspace", this.getWorkspaceId()), "layout:fileexplorerwidth");
    }

    private getRightToolPanelMetaAtom(): jotai.Atom<Partial<RightToolPanelState>> {
        return getOrefMetaKeyAtom(
            WOS.makeORef("workspace", this.getWorkspaceId()),
            RightToolPanelMetaKey as keyof MetaType
        ) as jotai.Atom<Partial<RightToolPanelState>>;
    }

    private initializeFromMeta(): void {
        try {
            const savedVTabWidth = globalStore.get(this.getVTabBarWidthAtom());
            const savedFileExplorerVisible = globalStore.get(this.getFileExplorerVisibleAtom());
            const savedFileExplorerWidth = globalStore.get(this.getFileExplorerWidthAtom());
            if (savedVTabWidth != null && savedVTabWidth > 0) {
                globalStore.set(this.vtabWidthAtom, clamp(savedVTabWidth, VTabBar_MinWidth, VTabBar_MaxWidth));
            }
            if (savedFileExplorerVisible != null) {
                globalStore.set(this.fileExplorerVisibleAtom, savedFileExplorerVisible);
            }
            if (savedFileExplorerWidth != null && savedFileExplorerWidth > 0) {
                // Initial FE width clamp is min-only; the runtime max
                // depends on the live window width, which the view
                // re-clamps on drag.
                globalStore.set(this.fileExplorerWidthAtom, Math.max(FileExplorer_MinWidth, savedFileExplorerWidth));
            }
            const tabBarPosition = globalStore.get(getSettingsKeyAtom("app:tabbar")) ?? "top";
            const showLeftTabBar = tabBarPosition === "left" && !isBuilderWindow();
            globalStore.set(this.vtabVisibleAtom, showLeftTabBar);
            this.hydrateRightToolPanelFromWorkspace();
        } catch (e) {
            console.warn("Failed to initialize from tab meta:", e);
        }
    }

    hydrateRightToolPanelFromWorkspace(): void {
        const workspaceId = this.getWorkspaceId();
        const savedRightToolPanel = globalStore.get(this.getRightToolPanelMetaAtom());
        globalStore.set(
            this.rightToolPanelAtom,
            normalizeRightToolPanelState(savedRightToolPanel, getRightToolPanelWindowWidth())
        );
        this.hydratedRightToolPanelWorkspaceId = workspaceId;
    }

    private ensureRightToolPanelWorkspaceCurrent(): void {
        if (this.hydratedRightToolPanelWorkspaceId === this.getWorkspaceId()) return;
        this.hydrateRightToolPanelFromWorkspace();
    }

    private persistRightToolPanelState(state: RightToolPanelState): void {
        try {
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("workspace", this.getWorkspaceId()),
                meta: {
                    [RightToolPanelMetaKey]: makePersistedRightToolPanelState(state),
                } as MetaType,
            });
        } catch (e) {
            console.warn("Failed to persist right tool panel state:", e);
        }
    }

    private setRightToolPanelState(state: RightToolPanelState, persist = true): void {
        this.ensureRightToolPanelWorkspaceCurrent();
        globalStore.set(this.rightToolPanelAtom, state);
        if (persist) {
            this.persistRightToolPanelState(state);
        }
    }

    // ---- Width clamps ----
    // The view passes `maxFn` to ResizeHandle as a live callback so the
    // upper bound tracks window resizes mid-drag (warp's `with_bounds_callback`).

    getVTabMinWidth(): number {
        return VTabBar_MinWidth;
    }

    getVTabMaxWidth(windowWidth: number, fileExplorerVisible: boolean, fileExplorerWidth: number): number {
        const otherSidePx = fileExplorerVisible ? fileExplorerWidth : 0;
        const budget = windowWidth - otherSidePx - Content_MinWidth;
        return Math.max(VTabBar_MinWidth, Math.min(VTabBar_MaxWidth, budget));
    }

    getFileExplorerMinWidth(): number {
        return FileExplorer_MinWidth;
    }

    getFileExplorerMaxWidth(windowWidth: number, vtabVisible: boolean, vtabWidth: number): number {
        const otherSidePx = vtabVisible ? vtabWidth : 0;
        const hardMax = Math.floor(windowWidth * FileExplorer_MaxWidthRatio);
        const budget = windowWidth - otherSidePx - Content_MinWidth;
        return Math.max(FileExplorer_MinWidth, Math.min(hardMax, budget));
    }

    // ---- Public getters ----

    getVTabVisible(): boolean {
        return globalStore.get(this.vtabVisibleAtom);
    }

    getFileExplorerVisible(): boolean {
        return globalStore.get(this.fileExplorerVisibleAtom);
    }

    getRightToolPanelState(): RightToolPanelState {
        this.ensureRightToolPanelWorkspaceCurrent();
        return globalStore.get(this.rightToolPanelAtom);
    }

    // ---- Toggle / visibility ----
    //
    // Each toggle ONLY mutates its own atom — no panel-ref calls, no
    // layout commits, no transition tweaking.  The view's conditional
    // render (workspace.tsx) handles the appearance/disappearance.

    setVTabVisible(visible: boolean): void {
        if (globalStore.get(this.vtabVisibleAtom) === visible) return;
        globalStore.set(this.vtabVisibleAtom, visible);
    }

    setFileExplorerVisible(visible: boolean): void {
        if (globalStore.get(this.fileExplorerVisibleAtom) === visible) return;
        globalStore.set(this.fileExplorerVisibleAtom, visible);
        // Persist visibility immediately — width is debounced but the
        // bool is a single byte and the user expects the next session
        // to come up in the same state.
        try {
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("workspace", this.getWorkspaceId()),
                meta: { "layout:fileexplorervisible": visible },
            });
        } catch (e) {
            console.warn("Failed to persist file explorer visibility:", e);
        }
    }

    // ---- Width setters (called by ResizeHandle during drag) ----

    setVTabWidth(widthPx: number): void {
        const fileExplorerVisible = globalStore.get(this.fileExplorerVisibleAtom);
        const fileExplorerWidth = globalStore.get(this.fileExplorerWidthAtom);
        const max = this.getVTabMaxWidth(window.innerWidth, fileExplorerVisible, fileExplorerWidth);
        const clamped = clamp(widthPx, VTabBar_MinWidth, max);
        globalStore.set(this.vtabWidthAtom, clamped);
        this.debouncedPersistVTabWidth();
    }

    setFileExplorerWidth(widthPx: number): void {
        const vtabVisible = globalStore.get(this.vtabVisibleAtom);
        const vtabWidth = globalStore.get(this.vtabWidthAtom);
        const max = this.getFileExplorerMaxWidth(window.innerWidth, vtabVisible, vtabWidth);
        const clamped = clamp(widthPx, FileExplorer_MinWidth, max);
        globalStore.set(this.fileExplorerWidthAtom, clamped);
        this.debouncedPersistFileExplorerWidth();
    }

    // ---- Code review panel (orthogonal, right side) ----

    setCodeReviewVisible(visible: boolean): void {
        globalStore.set(this.codeReviewVisibleAtom, visible);
        if (visible) {
            this.openRightTool("codeReview");
            return;
        }
        this.closeRightTool("codeReview");
    }

    getCodeReviewVisible(): boolean {
        return globalStore.get(this.codeReviewVisibleAtom);
    }

    // ---- Right tool panel (workspace-scoped, persisted in workspace meta) ----

    setRightToolPanelVisible(visible: boolean): void {
        const state = this.getRightToolPanelState();
        if (state.visible === visible) return;
        this.setRightToolPanelState({ ...state, visible });
    }

    setRightToolPanelWidth(widthPx: number): void {
        const state = this.getRightToolPanelState();
        this.setRightToolPanelState(setRightToolPanelStateWidth(state, widthPx, getRightToolPanelWindowWidth()));
    }

    openRightTool(tool: RightToolId): void {
        this.setRightToolPanelState(openRightTool(this.getRightToolPanelState(), tool));
    }

    selectRightTool(tool: RightToolId): void {
        const state = this.getRightToolPanelState();
        const nextState = selectRightTool(state, tool);
        if (nextState === state) return;
        this.setRightToolPanelState(nextState);
    }

    closeRightTool(tool: RightToolId): void {
        const state = this.getRightToolPanelState();
        const nextState = closeRightTool(state, tool);
        if (nextState === state) return;
        this.setRightToolPanelState(nextState);
    }

    setRightToolState(tool: RightToolId, toolState: unknown): void {
        const state = this.getRightToolPanelState();
        this.setRightToolPanelState({
            ...state,
            toolState: {
                ...state.toolState,
                [tool]: toolState,
            },
        });
    }

    setRightToolPanelFocused(focused: boolean): void {
        const state = this.getRightToolPanelState();
        if (state.focused === focused) return;
        this.setRightToolPanelState({ ...state, focused }, false);
    }

    setRightToolPanelMagnified(magnified: boolean): void {
        const state = this.getRightToolPanelState();
        if (state.magnified === magnified) return;
        this.setRightToolPanelState({ ...state, magnified }, false);
    }

    // ---- AI panel stubs (UI removed; keep API for older callers) ----

    getAIPanelVisible(): boolean {
        return false;
    }

    getAIPanelWidth(): number {
        return 0;
    }

    setAIPanelVisible(_visible: boolean, _opts?: { nofocus?: boolean }): void {
        // Wave AI panel removed from UI. Kept as a no-op so lingering callers
        // (termmodel / blockframe / etc.) don't crash. Refocus the current
        // block so the caller's intent (regain focus) still works.
        const layoutModel = getLayoutModelForStaticTab();
        const focusedNode = globalStore.get(layoutModel.focusedNode);
        const blockId = focusedNode?.data?.blockId;
        if (blockId != null) {
            refocusNode(blockId);
        }
    }
}

export { WorkspaceLayoutModel };
