// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { TopTabRuntime } from "./top-tab-runtime-registry";
import { WorkspaceTopTabRuntimeRegistry } from "./top-tab-runtime-registry";

function makeRuntime(): TopTabRuntime {
    return {
        getSnapshot: () => ({ dirty: false, title: "file.ts", status: "ready" }),
        subscribe: () => () => {},
        dispose: vi.fn(),
    };
}

describe("WorkspaceTopTabRuntimeRegistry", () => {
    it("creates one runtime per Top Tab and retains it until close", async () => {
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const runtime = makeRuntime();
        const factory = vi.fn(() => runtime);

        expect(registry.getOrCreate("file-1", factory)).toBe(runtime);
        expect(registry.getOrCreate("file-1", factory)).toBe(runtime);
        expect(factory).toHaveBeenCalledTimes(1);

        await registry.close("file-1");
        expect(runtime.dispose).toHaveBeenCalledTimes(1);
        expect(registry.get("file-1")).toBeUndefined();
    });

    it("disposes every runtime once when its workspace is replaced", async () => {
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const first = makeRuntime();
        const second = makeRuntime();
        registry.getOrCreate("file-1", () => first);
        registry.getOrCreate("preview-1", () => second);

        await registry.dispose();
        await registry.dispose();

        expect(first.dispose).toHaveBeenCalledTimes(1);
        expect(second.dispose).toHaveBeenCalledTimes(1);
        expect(registry.runtimes.size).toBe(0);
    });

    it("does not deliver a queued membership notification after unsubscribe", async () => {
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const listener = vi.fn();
        const unsubscribe = registry.subscribe("file-1", listener);

        registry.getOrCreate("file-1", makeRuntime);
        unsubscribe();
        await Promise.resolve();

        expect(listener).not.toHaveBeenCalled();
    });

    it("contains rejected fire-and-forget disposal", async () => {
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const runtime = makeRuntime();
        vi.mocked(runtime.dispose).mockRejectedValue(new Error("dispose failed"));
        registry.getOrCreate("file-1", () => runtime);

        await registry.disposeSafely();

        expect(registry.disposeErrors).toHaveLength(1);
        expect(registry.runtimes.size).toBe(0);
    });

    it("attempts every runtime and completes cleanup when bulk disposal has mixed failures", async () => {
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const syncFailure = makeRuntime();
        const asyncFailure = makeRuntime();
        const success = makeRuntime();
        vi.mocked(syncFailure.dispose).mockImplementation(() => {
            throw new Error("sync dispose failed");
        });
        vi.mocked(asyncFailure.dispose).mockRejectedValue(new Error("async dispose failed"));
        registry.getOrCreate("sync", () => syncFailure);
        registry.getOrCreate("async", () => asyncFailure);
        registry.getOrCreate("success", () => success);
        registry.subscribe("sync", vi.fn());

        await registry.disposeSafely();
        await registry.disposeSafely();

        expect(syncFailure.dispose).toHaveBeenCalledTimes(1);
        expect(asyncFailure.dispose).toHaveBeenCalledTimes(1);
        expect(success.dispose).toHaveBeenCalledTimes(1);
        expect(registry.runtimes.size).toBe(0);
        expect(registry.listeners.size).toBe(0);
        expect(registry.disposeErrors.map((error) => (error as Error).message)).toEqual([
            "sync dispose failed",
            "async dispose failed",
        ]);
    });
});
