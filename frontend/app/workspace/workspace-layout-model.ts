// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// WorkspaceLayoutModel — owns mode, visibility, and px width for one
// left panel. Mirrors warp's pattern (LeftPanelView
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
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/lib/layoutModelHooks";
import { atoms, getOrefMetaKeyAtom, refocusNode } from "@/store/global";
import * as jotai from "jotai";
import type { RightToolId, RightToolPanelState } from "./right-tool-panel-state";
import {
    closeRightTool,
    DefaultRightToolPanelState,
    getRightToolPanelMaxWidth as getRightToolPanelStateMaxWidth,
    makePersistedRightToolPanelState,
    MinRightToolPanelWidth,
    normalizeRightToolPanelState,
    openRightTool,
    selectRightTool,
    setRightToolPanelWidth as setRightToolPanelStateWidth,
} from "./right-tool-panel-state";

// Width constants — warp parity.
//   warp/drive/panel.rs:38           MIN_SIDEBAR_WIDTH      = 250.
//   warp/drive/panel.rs:39           MAX_SIDEBAR_WIDTH_RATIO = 0.75
//   warp/terminal/resizable_data.rs:16  DEFAULT_LEFT_PANEL_WIDTH = 240.
// crest keeps one shared slot for files, sessions, and terminals.
const LeftPanelDefaultWidth = 260;
const LeftPanelMinWidth = 180;
const LeftPanelMaxWidthRatio = 0.5;

// Floor for the content panel — side panels can never
// take more than (window - this) px.  Matches the spirit of warp's
// max_width clamp without needing a runtime window-size callback.
const Content_MinWidth = 320;
const RightToolPanelWindowWidthFallback = 1200;
export const RightToolPanelMetaKey = "layout:righttoolpanel";
export const LeftPanelMetaKey = "layout:leftpanel";

export type LeftPanelMode = "files" | "sessions" | "terminals";
type PersistedLeftPanelState = NonNullable<MetaType[typeof LeftPanelMetaKey]>;
export type LeftPanelState = Omit<PersistedLeftPanelState, "mode"> & {
    mode: LeftPanelMode;
};

const DefaultLeftPanelState: LeftPanelState = {
    visible: false,
    mode: "files",
    width: LeftPanelDefaultWidth,
};

function clamp(value: number, min: number, max: number): number {
    if (max < min) return min;
    return Math.max(min, Math.min(value, max));
}

function isLeftPanelMode(mode: string): mode is LeftPanelMode {
    return mode === "files" || mode === "sessions" || mode === "terminals";
}

function getRightToolPanelWindowWidth(): number {
    return globalThis.window?.innerWidth ?? RightToolPanelWindowWidthFallback;
}

class WorkspaceLayoutModel {
    private static instance: WorkspaceLayoutModel | null = null;

    // ---- Source-of-truth atoms ----
    leftPanelAtom: jotai.PrimitiveAtom<LeftPanelState>;
    // Right-side code-review panel — orthogonal to the left panel.
    codeReviewVisibleAtom: jotai.PrimitiveAtom<boolean>;
    codeReviewWideAtom: jotai.PrimitiveAtom<boolean>;
    // Legacy: AI panel was removed but external callers still import the
    // atom + setter.  Keep them as harmless no-ops.
    panelVisibleAtom: jotai.PrimitiveAtom<boolean>;
    rightToolPanelAtom: jotai.PrimitiveAtom<RightToolPanelState>;

    private leftPanelPersistTimer: ReturnType<typeof setTimeout>;
    private hydratedLeftPanelWorkspaceId = "";
    private hydratedRightToolPanelWorkspaceId = "";

    private constructor() {
        this.leftPanelAtom = jotai.atom({ ...DefaultLeftPanelState });
        this.codeReviewVisibleAtom = jotai.atom(false);
        this.codeReviewWideAtom = jotai.atom(false);
        this.panelVisibleAtom = jotai.atom(false);
        this.rightToolPanelAtom = jotai.atom({ ...DefaultRightToolPanelState });

        this.initializeFromMeta();
    }

    static getInstance(): WorkspaceLayoutModel {
        if (!WorkspaceLayoutModel.instance) {
            WorkspaceLayoutModel.instance = new WorkspaceLayoutModel();
        }
        return WorkspaceLayoutModel.instance;
    }

    static resetInstance(): void {
        if (WorkspaceLayoutModel.instance?.leftPanelPersistTimer != null) {
            clearTimeout(WorkspaceLayoutModel.instance.leftPanelPersistTimer);
        }
        WorkspaceLayoutModel.instance = null;
    }

    // ---- Meta / persistence helpers ----

    private getWorkspaceId(): string {
        return globalStore.get(atoms.workspace)?.oid ?? "";
    }

    private getLeftPanelMetaAtomForWorkspace(workspaceId: string): jotai.Atom<PersistedLeftPanelState> {
        return getOrefMetaKeyAtom(WOS.makeORef("workspace", workspaceId), LeftPanelMetaKey);
    }

    private getLeftPanelMetaAtom(): jotai.Atom<PersistedLeftPanelState> {
        return this.getLeftPanelMetaAtomForWorkspace(this.getWorkspaceId());
    }

    private getRightToolPanelMetaAtomForWorkspace(workspaceId: string): jotai.Atom<Partial<RightToolPanelState>> {
        return getOrefMetaKeyAtom(
            WOS.makeORef("workspace", workspaceId),
            RightToolPanelMetaKey as keyof MetaType
        ) as jotai.Atom<Partial<RightToolPanelState>>;
    }

    private getRightToolPanelMetaAtom(): jotai.Atom<Partial<RightToolPanelState>> {
        return this.getRightToolPanelMetaAtomForWorkspace(this.getWorkspaceId());
    }

    private initializeFromMeta(): void {
        try {
            this.hydrateLeftPanelFromWorkspace();
            this.hydrateRightToolPanelFromWorkspace();
        } catch (e) {
            console.warn("Failed to initialize from tab meta:", e);
        }
    }

    hydrateLeftPanelFromWorkspace(): void {
        const workspaceId = this.getWorkspaceId();
        if (this.leftPanelPersistTimer != null) {
            clearTimeout(this.leftPanelPersistTimer);
            this.leftPanelPersistTimer = undefined;
        }
        const saved = globalStore.get(this.getLeftPanelMetaAtom());
        const state = this.normalizeLeftPanelState(saved);
        globalStore.set(this.leftPanelAtom, state);
        this.hydratedLeftPanelWorkspaceId = workspaceId;
    }

    private normalizeLeftPanelState(saved: PersistedLeftPanelState): LeftPanelState {
        if (
            typeof saved?.visible !== "boolean" ||
            !isLeftPanelMode(saved.mode) ||
            !Number.isFinite(saved.width) ||
            saved.width <= 0
        ) {
            return { ...DefaultLeftPanelState };
        }
        return {
            visible: saved.visible,
            mode: saved.mode,
            width: clamp(saved.width, LeftPanelMinWidth, this.getLeftPanelMaxWidth(getRightToolPanelWindowWidth())),
        };
    }

    private ensureLeftPanelWorkspaceCurrent(): void {
        if (this.hydratedLeftPanelWorkspaceId === this.getWorkspaceId()) return;
        this.hydrateLeftPanelFromWorkspace();
    }

    getLeftPanelStateForWorkspace(workspaceId: string, hydratedState: LeftPanelState): LeftPanelState {
        if (this.hydratedLeftPanelWorkspaceId === workspaceId) {
            return hydratedState;
        }
        return this.normalizeLeftPanelState(globalStore.get(this.getLeftPanelMetaAtomForWorkspace(workspaceId)));
    }

    private persistLeftPanelState(workspaceId: string, state: LeftPanelState): void {
        if (workspaceId !== this.getWorkspaceId() || workspaceId !== this.hydratedLeftPanelWorkspaceId) return;
        try {
            RpcApi.SetMetaCommand(TabRpcClient, {
                oref: WOS.makeORef("workspace", workspaceId),
                meta: { [LeftPanelMetaKey]: state },
            });
        } catch (e) {
            console.warn("Failed to persist left panel state:", e);
        }
    }

    hydrateRightToolPanelFromWorkspace(): void {
        const workspaceId = this.getWorkspaceId();
        const savedRightToolPanel = globalStore.get(this.getRightToolPanelMetaAtom());
        const normalizedState = normalizeRightToolPanelState(savedRightToolPanel, getRightToolPanelWindowWidth());
        globalStore.set(this.rightToolPanelAtom, normalizedState);
        this.syncLegacyCodeReviewVisible(normalizedState);
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
        this.syncLegacyCodeReviewVisible(state);
        if (persist) {
            this.persistRightToolPanelState(state);
        }
    }

    private syncLegacyCodeReviewVisible(state: RightToolPanelState): void {
        globalStore.set(this.codeReviewVisibleAtom, state.visible && state.openedTools.includes("codeReview"));
    }

    // ---- Width clamps ----
    // The view passes `maxFn` to ResizeHandle as a live callback so the
    // upper bound tracks window resizes mid-drag (warp's `with_bounds_callback`).

    getLeftPanelMinWidth(): number {
        return LeftPanelMinWidth;
    }

    getLeftPanelMaxWidth(windowWidth: number): number {
        const hardMax = Math.floor(windowWidth * LeftPanelMaxWidthRatio);
        return Math.max(LeftPanelMinWidth, Math.min(hardMax, windowWidth - Content_MinWidth));
    }

    getRightToolPanelMaxWidth(windowWidth: number, leftPanelVisible: boolean, leftPanelWidth: number): number {
        const leftSidePx = leftPanelVisible ? leftPanelWidth : 0;
        const hardMax = getRightToolPanelStateMaxWidth(windowWidth);
        const budget = windowWidth - leftSidePx - Content_MinWidth;
        return Math.max(MinRightToolPanelWidth, Math.min(hardMax, budget));
    }

    // ---- Public getters ----

    getRightToolPanelState(): RightToolPanelState {
        this.ensureRightToolPanelWorkspaceCurrent();
        return globalStore.get(this.rightToolPanelAtom);
    }

    getRightToolPanelStateForWorkspace(workspaceId: string, hydratedState: RightToolPanelState): RightToolPanelState {
        if (this.hydratedRightToolPanelWorkspaceId === workspaceId) {
            return hydratedState;
        }
        const savedRightToolPanel = globalStore.get(this.getRightToolPanelMetaAtomForWorkspace(workspaceId));
        return normalizeRightToolPanelState(savedRightToolPanel, getRightToolPanelWindowWidth());
    }

    // ---- Toggle / visibility ----
    //
    // Each toggle ONLY mutates its own atom — no panel-ref calls, no
    // layout commits, no transition tweaking.  The view's conditional
    // render (workspace.tsx) handles the appearance/disappearance.

    toggleLeftPanel(mode: LeftPanelMode): void {
        this.ensureLeftPanelWorkspaceCurrent();
        const state = globalStore.get(this.leftPanelAtom);
        const nextState = {
            ...state,
            visible: state.mode === mode ? !state.visible : true,
            mode,
        };
        globalStore.set(this.leftPanelAtom, nextState);
        this.persistLeftPanelState(this.getWorkspaceId(), nextState);
    }

    showLeftPanel(mode: LeftPanelMode): void {
        this.ensureLeftPanelWorkspaceCurrent();
        const state = globalStore.get(this.leftPanelAtom);
        const nextState = {
            ...state,
            visible: true,
            mode,
        };
        globalStore.set(this.leftPanelAtom, nextState);
        this.persistLeftPanelState(this.getWorkspaceId(), nextState);
    }

    previewLeftPanelWidth(widthPx: number): void {
        this.ensureLeftPanelWorkspaceCurrent();
        const state = globalStore.get(this.leftPanelAtom);
        globalStore.set(this.leftPanelAtom, {
            ...state,
            width: clamp(widthPx, LeftPanelMinWidth, this.getLeftPanelMaxWidth(getRightToolPanelWindowWidth())),
        });
    }

    setLeftPanelWidth(widthPx: number): void {
        this.previewLeftPanelWidth(widthPx);
        if (this.leftPanelPersistTimer != null) {
            clearTimeout(this.leftPanelPersistTimer);
        }
        const workspaceId = this.getWorkspaceId();
        this.leftPanelPersistTimer = setTimeout(() => {
            this.leftPanelPersistTimer = undefined;
            this.persistLeftPanelState(workspaceId, globalStore.get(this.leftPanelAtom));
        }, 300);
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
        this.setRightToolPanelState({
            ...state,
            visible,
            focused: visible ? state.focused : false,
            magnified: visible ? state.magnified : false,
        });
    }

    private makeRightToolPanelWidthState(widthPx: number): RightToolPanelState {
        const state = this.getRightToolPanelState();
        this.ensureLeftPanelWorkspaceCurrent();
        const leftPanel = globalStore.get(this.leftPanelAtom);
        const maxWidth = this.getRightToolPanelMaxWidth(
            getRightToolPanelWindowWidth(),
            leftPanel.visible,
            leftPanel.width
        );
        const nextState = setRightToolPanelStateWidth(
            state,
            Math.min(widthPx, maxWidth),
            getRightToolPanelWindowWidth()
        );
        return nextState;
    }

    previewRightToolPanelWidth(widthPx: number): void {
        this.setRightToolPanelState(this.makeRightToolPanelWidthState(widthPx), false);
    }

    setRightToolPanelWidth(widthPx: number): void {
        this.setRightToolPanelState(this.makeRightToolPanelWidthState(widthPx));
    }

    openRightTool(tool: RightToolId): void {
        this.setRightToolPanelState(openRightTool(this.getRightToolPanelState(), tool));
    }

    openRightEditorTool(): void {
        this.openRightTool("editor");
        this.setRightToolPanelFocused(false);
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
        if (magnified && (!state.visible || state.openedTools.length === 0)) return;
        if (state.magnified === magnified) return;
        globalStore.set(this.codeReviewWideAtom, false);
        if (magnified) {
            this.clearMagnifiedLayoutNode();
        }
        this.setRightToolPanelState({ ...state, magnified }, false);
    }

    private clearMagnifiedLayoutNode(): void {
        if (atoms.staticTabId == null) return;
        const layoutModel = getLayoutModelForStaticTab();
        const magnifiedNodeId = layoutModel.magnifiedNodeId;
        if (magnifiedNodeId == null) return;
        layoutModel.magnifyNodeToggle(magnifiedNodeId);
    }

    toggleFocusedRightToolPanelMagnified(): boolean {
        const state = this.getRightToolPanelState();
        if (!state.visible || !state.focused || state.openedTools.length === 0) {
            return false;
        }
        this.setRightToolPanelMagnified(!state.magnified);
        return true;
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
