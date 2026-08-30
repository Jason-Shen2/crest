// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface WorkspaceOverlayControllerDeps<TerminalView> {
    raiseWorkspace: () => void;
    focusWorkspace: () => void;
    raiseTerminal: (view: TerminalView) => void;
    focusTerminal: (view: TerminalView) => void;
    restoreSurface: () => void;
}

export class WorkspaceOverlayController<TerminalView> {
    deps: WorkspaceOverlayControllerDeps<TerminalView>;
    visible = false;

    constructor(deps: WorkspaceOverlayControllerDeps<TerminalView>) {
        this.deps = deps;
    }

    setVisible(visible: boolean): boolean {
        if (this.visible === visible) return false;
        this.visible = visible;
        if (visible) {
            this.deps.raiseWorkspace();
            this.deps.focusWorkspace();
            return true;
        }
        this.deps.restoreSurface();
        return true;
    }

    attachTerminal(view: TerminalView) {
        this.deps.raiseTerminal(view);
        if (this.visible) {
            this.deps.raiseWorkspace();
        }
    }

    showWorkspace() {
        this.deps.raiseWorkspace();
        this.deps.focusWorkspace();
    }

    raiseTerminal(view: TerminalView): boolean {
        if (this.visible) return false;
        this.deps.raiseTerminal(view);
        return true;
    }

    focusTerminal(view: TerminalView): boolean {
        if (this.visible) return false;
        this.deps.focusTerminal(view);
        return true;
    }
}
