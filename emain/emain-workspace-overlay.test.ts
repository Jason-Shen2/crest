// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { WorkspaceOverlayController } from "./emain-workspace-overlay";

describe("WorkspaceOverlayController", () => {
    it("keeps Terminal alive behind Workspace while an overlay is visible and restores it on close", () => {
        const calls: string[] = [];
        const controller = new WorkspaceOverlayController<string>({
            raiseWorkspace: () => calls.push("raise-workspace"),
            focusWorkspace: () => calls.push("focus-workspace"),
            raiseTerminal: (terminal) => calls.push(`raise-terminal:${terminal}`),
            focusTerminal: (terminal) => calls.push(`focus-terminal:${terminal}`),
            restoreSurface: () => calls.push("restore-surface"),
        });

        expect(controller.raiseTerminal("terminal-a")).toBe(true);
        expect(controller.focusTerminal("terminal-a")).toBe(true);

        expect(controller.setVisible(true)).toBe(true);
        controller.attachTerminal("terminal-b");
        expect(controller.raiseTerminal("terminal-a")).toBe(false);
        expect(controller.focusTerminal("terminal-a")).toBe(false);
        expect(controller.setVisible(true)).toBe(false);

        expect(controller.setVisible(false)).toBe(true);
        controller.showWorkspace();
        expect(calls).toEqual([
            "raise-terminal:terminal-a",
            "focus-terminal:terminal-a",
            "raise-workspace",
            "focus-workspace",
            "raise-terminal:terminal-b",
            "raise-workspace",
            "restore-surface",
            "raise-workspace",
            "focus-workspace",
        ]);
    });
});
