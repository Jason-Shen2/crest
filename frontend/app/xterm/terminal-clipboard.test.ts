// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readTerminalClipboard, writeTerminalClipboard } from "./terminal-clipboard";

const web = {
    readText: vi.fn<() => Promise<string>>(),
    writeText: vi.fn<(t: string) => Promise<void>>(),
};

const original = globalThis.navigator;

function setNavigator(value: unknown) {
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value,
    });
}

describe("terminalClipboard", () => {
    beforeEach(() => {
        web.readText.mockReset();
        web.writeText.mockReset();
        setNavigator({ clipboard: web });
    });

    afterEach(() => {
        setNavigator(original);
    });

    it("reads from the web clipboard", async () => {
        web.readText.mockResolvedValue("web");
        await expect(readTerminalClipboard()).resolves.toBe("web");
    });

    it("returns an empty string when the read fails", async () => {
        web.readText.mockRejectedValue(new Error("denied"));
        await expect(readTerminalClipboard()).resolves.toBe("");
    });

    it("returns an empty string when no clipboard is available", async () => {
        setNavigator({});
        await expect(readTerminalClipboard()).resolves.toBe("");
    });

    it("writes to the web clipboard", async () => {
        web.writeText.mockResolvedValue();
        await writeTerminalClipboard("copied");
        expect(web.writeText).toHaveBeenCalledWith("copied");
    });

    it("swallows write failures", async () => {
        web.writeText.mockRejectedValue(new Error("denied"));
        await expect(writeTerminalClipboard("x")).resolves.toBeUndefined();
    });

    it("does nothing on write when no clipboard is available", async () => {
        setNavigator({});
        await expect(writeTerminalClipboard("x")).resolves.toBeUndefined();
        expect(web.writeText).not.toHaveBeenCalled();
    });
});
