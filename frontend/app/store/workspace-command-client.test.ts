// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = { sendWorkspaceCommand: vi.fn() };
vi.mock("./global", () => ({ getApi: () => mockApi }));

import { sendWorkspaceCommand } from "./workspace-command-client";

describe("sendWorkspaceCommand", () => {
    beforeEach(() => mockApi.sendWorkspaceCommand.mockReset());

    it("forwards a serializable content command through preload only", () => {
        const command: WorkspaceCommand = { type: "open-file", path: "/repo/app.ts" };
        sendWorkspaceCommand(command);
        expect(mockApi.sendWorkspaceCommand).toHaveBeenCalledWith(command);
    });

    it("rejects invalid content command input", () => {
        expect(() => sendWorkspaceCommand({ type: "open-url", url: "file:///tmp/a" })).toThrow();
        expect(mockApi.sendWorkspaceCommand).not.toHaveBeenCalled();
    });

    it.each(["/repo/app.ts", "C:\\repo\\app.ts", "\\\\server\\share\\app.ts"])(
        "accepts cross-platform absolute path %s",
        (path) => {
            const command: WorkspaceCommand = { type: "open-preview", path };
            sendWorkspaceCommand(command);
            expect(mockApi.sendWorkspaceCommand).toHaveBeenCalledWith(command);
            mockApi.sendWorkspaceCommand.mockReset();
        }
    );

    it.each(["repo/app.ts", "C:repo\\app.ts", "\\\\server", "file:///repo/app.ts", ""])(
        "rejects invalid local path %s",
        (path) => {
            expect(() => sendWorkspaceCommand({ type: "open-file", path })).toThrow();
            expect(mockApi.sendWorkspaceCommand).not.toHaveBeenCalled();
        }
    );
});
