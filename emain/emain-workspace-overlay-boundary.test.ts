// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
    return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

describe("workspace overlay integration boundary", () => {
    it("reports modal visibility through an authenticated WorkspaceView IPC channel", () => {
        const renderer = source("frontend/app/modals/modalsrenderer.tsx");
        const closeDialog = source("frontend/app/workspace/top-tab-close-dialog.tsx");
        const sourceControl = source("frontend/app/sourcecontrol/source-control-panel.tsx");
        const preload = source("emain/preload.ts");
        const main = source("emain/emain-window.ts");

        expect(renderer).toContain('import { WorkspaceModalOverlay } from "./workspace-modal-overlay";');
        expect(renderer).toContain("<WorkspaceModalOverlay visible={rtn.length > 0} />");
        expect(closeDialog).toContain("<WorkspaceModalOverlay visible />");
        expect(sourceControl).toContain("<WorkspaceModalOverlay visible />");
        expect(preload).toContain(
            'setWorkspaceOverlayVisible: (visible) => ipcRenderer.send("workspace-overlay-visible", visible)'
        );
        expect(main).toContain('ipcMain.on("workspace-overlay-visible"');
        expect(main).toContain('typeof visible !== "boolean"');
        expect(main).toContain("getWorkspaceViewByWebContentsId(event.sender.id)");
    });

    it("routes every Terminal raise through the overlay controller and restores the current surface", () => {
        const main = source("emain/emain-window.ts");

        expect(main).toContain("workspaceOverlayController: WorkspaceOverlayController<WaveTabView>");
        expect(main).toContain("this.workspaceOverlayController.raiseTerminal(tabView)");
        expect(main).toContain("this.workspaceOverlayController.focusTerminal(tabView)");
        expect(main).toContain("this.workspaceOverlayController.attachTerminal(tabView)");
        expect(main).toContain("!this.workspaceOverlayController.visible");
        expect(main).toContain("restoreSurface: () => this.restoreWorkspaceSurfaceAfterOverlay()");
        expect(main).toContain("this.terminalSurfaceController.isViewReady(tabView)");
        expect(main).toContain("canShowTerminal: (view) => this.canShowTerminalSurface(view as WaveTabView)");
        expect(main).toContain("this.workspaceSurface.bounds.width > 0");
        expect(main).toContain("this.workspaceSurface.bounds.height > 0");
        expect(main).toContain("this.workspaceOverlayController.setVisible(visible)");
        expect(main).toContain("window.workspaceOverlayController.focusTerminal(window.activeTabView)");
    });
});
