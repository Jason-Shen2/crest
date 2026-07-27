// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";

import {
    resolveWaveWindowByWebContentsId,
    routeWorkspaceCloseResponseByWebContentsId,
    routeWorkspaceCommandByWebContentsId,
} from "./emain-window-sender";

describe("resolveWaveWindowByWebContentsId", () => {
    it("resolves a WorkspaceView sender through its owning window id", () => {
        const waveWindow = { waveWindowId: "window-1" };
        const getWaveWindowById = vi.fn().mockReturnValue(waveWindow);

        const result = resolveWaveWindowByWebContentsId(101, {
            getWaveTabViewByWebContentsId: vi.fn(),
            getWorkspaceViewByWebContentsId: vi.fn().mockReturnValue({ waveWindowId: "window-1" }),
            getWaveWindowByTabId: vi.fn(),
            getWaveWindowById,
        });

        expect(result).toBe(waveWindow);
        expect(getWaveWindowById).toHaveBeenCalledWith("window-1");
    });

    it("preserves WaveTabView sender resolution through its tab id", () => {
        const waveWindow = { waveWindowId: "window-1" };
        const getWaveWindowByTabId = vi.fn().mockReturnValue(waveWindow);

        const result = resolveWaveWindowByWebContentsId(202, {
            getWaveTabViewByWebContentsId: vi.fn().mockReturnValue({ waveTabId: "tab-1" }),
            getWorkspaceViewByWebContentsId: vi.fn(),
            getWaveWindowByTabId,
            getWaveWindowById: vi.fn(),
        });

        expect(result).toBe(waveWindow);
        expect(getWaveWindowByTabId).toHaveBeenCalledWith("tab-1");
    });
});

describe("workspace close response sender lookup", () => {
    it("forwards the exact response with its authenticated renderer id", () => {
        const resolveWorkspaceClose = vi.fn();
        routeWorkspaceCloseResponseByWebContentsId(
            505,
            { requestid: "request-1", allow: true },
            {
                getWaveWindowByWebContentsId: vi.fn().mockReturnValue({ resolveWorkspaceClose }),
            }
        );
        expect(resolveWorkspaceClose).toHaveBeenCalledWith(505, { requestid: "request-1", allow: true });
    });
});

describe("workspace command sender lookup", () => {
    it("routes a WorkspaceView sender command to its owning window", () => {
        const command = { type: "activate-agent" };
        const getWaveWindowByWebContentsId = vi.fn().mockReturnValue({ waveWindowId: "window-1" });
        const sendWorkspaceCommand = vi.fn();

        routeWorkspaceCommandByWebContentsId(303, command, {
            getWaveWindowByWebContentsId,
            sendWorkspaceCommand,
        });

        expect(getWaveWindowByWebContentsId).toHaveBeenCalledWith(303);
        expect(sendWorkspaceCommand).toHaveBeenCalledWith("window-1", command);
    });

    it("does not route commands from an unknown sender", () => {
        const sendWorkspaceCommand = vi.fn();

        routeWorkspaceCommandByWebContentsId(
            404,
            { type: "activate-agent" },
            {
                getWaveWindowByWebContentsId: vi.fn(),
                sendWorkspaceCommand,
            }
        );

        expect(sendWorkspaceCommand).not.toHaveBeenCalled();
    });
});

describe("legacy Wave Tab IPC hard cut", () => {
    it("does not expose generic tab mutation channels", () => {
        const windowSource = fs.readFileSync(new URL("./emain-window.ts", import.meta.url), "utf8");
        const preloadSource = fs.readFileSync(new URL("./preload.ts", import.meta.url), "utf8");
        for (const channel of ["set-active", "create", "close"].map((prefix) => `${prefix}-tab`)) {
            expect(windowSource).not.toContain(`"${channel}"`);
            expect(preloadSource).not.toContain(`"${channel}"`);
        }
    });

    it("detects unsaved Top Tab, Terminal Tab, and Agent content without legacy tabids", () => {
        const windowSource = fs.readFileSync(new URL("./emain-window.ts", import.meta.url), "utf8");
        const detector = windowSource.slice(
            windowSource.indexOf("function isNonEmptyUnsavedWorkspace"),
            windowSource.indexOf("function isNonEmptyUnsavedWorkspace") + 600
        );
        expect(detector).toContain("contentstate.toptabs");
        expect(detector).toContain("terminaltabids");
        expect(detector).toContain("agentstate");
        expect(detector).not.toMatch(/workspace\.tabids/);
    });
});
