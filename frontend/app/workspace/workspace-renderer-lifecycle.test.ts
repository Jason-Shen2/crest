// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { teardownWorkspaceRenderer } from "./workspace-renderer-lifecycle";

describe("workspace renderer lifecycle", () => {
    it("starts a best-effort checkpoint before clearing subscriptions and shutting down WSH", () => {
        const calls: string[] = [];
        const flush = vi.fn(() => {
            calls.push("flush");
            return Promise.reject(new Error("window is unloading"));
        });
        const clearSubscriptions = vi.fn(() => calls.push("clear"));
        const shutdownWshrpc = vi.fn(() => calls.push("shutdown"));

        expect(() => teardownWorkspaceRenderer({ flush, clearSubscriptions, shutdownWshrpc })).not.toThrow();
        expect(calls).toEqual(["flush", "clear", "shutdown"]);
    });
});
