// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { openFileInEditorTab } from "./open-editor-tab";

describe("openFileInEditorTab", () => {
    it("delegates only to the Workspace Top Tab controller", async () => {
        const controller = { openFile: vi.fn().mockReturnValue("file-1") };
        await expect(openFileInEditorTab("/repo/app.ts", controller)).resolves.toEqual({
            tabId: "file-1",
            created: true,
        });
        expect(controller.openFile).toHaveBeenCalledWith("/repo/app.ts");
    });
});
