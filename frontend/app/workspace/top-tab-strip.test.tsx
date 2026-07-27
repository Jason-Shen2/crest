// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TopTabRuntime, TopTabRuntimeSnapshot } from "./top-tab-runtime-registry";
import { WorkspaceTopTabRuntimeRegistry } from "./top-tab-runtime-registry";
import { TopTabStrip } from "./top-tab-strip";

const getFileIconMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/fileexplorer/file-icon", () => ({
    getFileIcon: getFileIconMock,
}));

const Tabs = [
    { id: "file-1", kind: "file" as const, path: "/repo/app.ts", title: "app.ts" },
    { id: "file-2", kind: "file" as const, path: "/repo/test.ts", title: "test.ts" },
];

class FakeRuntime implements TopTabRuntime {
    snapshot: TopTabRuntimeSnapshot = { dirty: false, title: "app.ts", status: "ready" };
    listeners = new Set<() => void>();

    getSnapshot = () => this.snapshot;
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };
    dispose = vi.fn();
    emit(snapshot: TopTabRuntimeSnapshot) {
        this.snapshot = snapshot;
        this.listeners.forEach((listener) => listener());
    }
}

beforeEach(() => {
    getFileIconMock.mockImplementation((name: string) => {
        return ({ className, size }: { className?: string; size?: number }) => (
            <svg className={className} data-file-icon={name} data-size={size} />
        );
    });
});

afterEach(() => {
    cleanup();
    getFileIconMock.mockReset();
});

describe("TopTabStrip", () => {
    it("activates a clicked tab and closes without accidental activation", () => {
        const activate = vi.fn();
        const close = vi.fn().mockResolvedValue(true);
        render(
            <TopTabStrip
                tabs={Tabs}
                activeTopTabId="file-1"
                registry={new WorkspaceTopTabRuntimeRegistry()}
                onActivate={activate}
                onClose={close}
                onReorder={vi.fn()}
            />
        );

        fireEvent.click(screen.getByRole("tab", { name: "test.ts" }));
        expect(activate).toHaveBeenCalledWith("file-2");
        activate.mockClear();
        fireEvent.click(screen.getByRole("button", { name: "Close app.ts" }));
        expect(close).toHaveBeenCalledWith("file-1");
        expect(activate).not.toHaveBeenCalled();
    });

    it("reorders by pointer and provides one roving keyboard tab stop", () => {
        const activate = vi.fn();
        const reorder = vi.fn();
        render(
            <TopTabStrip
                tabs={Tabs}
                activeTopTabId="file-1"
                registry={new WorkspaceTopTabRuntimeRegistry()}
                onActivate={activate}
                onClose={vi.fn().mockResolvedValue(true)}
                onReorder={reorder}
            />
        );

        const app = screen.getByRole("tab", { name: "app.ts" });
        const test = screen.getByRole("tab", { name: "test.ts" });
        expect(app.tabIndex).toBe(0);
        expect(test.tabIndex).toBe(-1);
        fireEvent.pointerDown(app);
        fireEvent.pointerUp(test);
        expect(reorder).toHaveBeenCalledWith("file-1", 1);
        fireEvent.keyDown(app, { key: "ArrowRight" });
        expect(activate).toHaveBeenCalledWith("file-2");
        expect(document.activeElement).toBe(test);
    });

    it.each(["Enter", " "])("activates the focused tab with %s", (key) => {
        const activate = vi.fn();
        render(
            <TopTabStrip
                tabs={Tabs}
                activeTopTabId="file-1"
                registry={new WorkspaceTopTabRuntimeRegistry()}
                onActivate={activate}
                onClose={vi.fn().mockResolvedValue(true)}
                onReorder={vi.fn()}
            />
        );

        const test = screen.getByRole("tab", { name: "test.ts" });
        expect(test.tagName).toBe("BUTTON");
        fireEvent.keyDown(test, { key });
        expect(activate).toHaveBeenCalledWith("file-2");
    });

    it.each(["pointerCancel", "lostPointerCapture"])("does not reorder after %s", (eventName) => {
        const reorder = vi.fn();
        render(
            <TopTabStrip
                tabs={Tabs}
                activeTopTabId="file-1"
                registry={new WorkspaceTopTabRuntimeRegistry()}
                onActivate={vi.fn()}
                onClose={vi.fn().mockResolvedValue(true)}
                onReorder={reorder}
            />
        );

        const app = screen.getByRole("tab", { name: "app.ts" });
        const test = screen.getByRole("tab", { name: "test.ts" });
        fireEvent.pointerDown(app);
        fireEvent[eventName](app);
        fireEvent.pointerUp(test);

        expect(reorder).not.toHaveBeenCalled();
    });

    it("clears pointer reorder state when the pointer is released outside the strip", () => {
        const reorder = vi.fn();
        render(
            <TopTabStrip
                tabs={Tabs}
                activeTopTabId="file-1"
                registry={new WorkspaceTopTabRuntimeRegistry()}
                onActivate={vi.fn()}
                onClose={vi.fn().mockResolvedValue(true)}
                onReorder={reorder}
            />
        );

        const app = screen.getByRole("tab", { name: "app.ts" });
        const test = screen.getByRole("tab", { name: "test.ts" });
        fireEvent.pointerDown(app);
        fireEvent.pointerUp(window);
        fireEvent.pointerUp(test);

        expect(reorder).not.toHaveBeenCalled();
    });

    it("subscribes to runtime title and dirty updates", () => {
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const runtime = new FakeRuntime();
        registry.getOrCreate("file-1", () => runtime);
        render(
            <TopTabStrip
                tabs={Tabs.slice(0, 1)}
                activeTopTabId="file-1"
                registry={registry}
                onActivate={vi.fn()}
                onClose={vi.fn().mockResolvedValue(true)}
                onReorder={vi.fn()}
            />
        );

        act(() => runtime.emit({ dirty: true, title: "changed.ts", status: "ready" }));

        expect(screen.getByRole("tab", { name: "changed.ts, unsaved changes" })).toBeTruthy();
        expect(screen.getByTestId("top-tab-dirty-file-1")).toBeTruthy();
    });

    it("uses descriptor basename file icons independent of runtime title", () => {
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const runtime = new FakeRuntime();
        runtime.snapshot = { dirty: false, title: "Runtime Agent IPC", status: "ready" };
        registry.getOrCreate("agent", () => runtime);
        const tabs = [
            { id: "agent", kind: "file" as const, path: "/repo/src/agent-ipc.ts", title: "Descriptor Agent IPC" },
            { id: "app", kind: "file" as const, path: "C:\\repo\\frontend\\app.tsx", title: "Runtime App" },
            { id: "package", kind: "file" as const, path: "/repo/package.json", title: "Runtime Package" },
            { id: "readme", kind: "file" as const, path: "\\repo\\README.md", title: "Runtime Readme" },
            { id: "notice", kind: "file" as const, path: "/repo/NOTICE.crest", title: "Runtime Notice" },
        ];

        const { container } = render(
            <TopTabStrip
                tabs={tabs}
                activeTopTabId="agent"
                registry={registry}
                onActivate={vi.fn()}
                onClose={vi.fn().mockResolvedValue(true)}
                onReorder={vi.fn()}
            />
        );

        for (const fileName of ["agent-ipc.ts", "app.tsx", "package.json", "README.md", "NOTICE.crest"]) {
            expect(getFileIconMock).toHaveBeenCalledWith(fileName, false, false);
            const icon = container.querySelector(`[data-file-icon="${fileName}"]`);
            expect(icon?.getAttribute("data-size")).toBe("14");
        }
    });

    it("styles active and inactive tabs as soft pills", () => {
        render(
            <TopTabStrip
                tabs={Tabs}
                activeTopTabId="file-1"
                registry={new WorkspaceTopTabRuntimeRegistry()}
                onActivate={vi.fn()}
                onClose={vi.fn().mockResolvedValue(true)}
                onReorder={vi.fn()}
            />
        );

        const activeTab = screen.getByRole("tab", { name: "app.ts" });
        const inactiveTab = screen.getByRole("tab", { name: "test.ts" });
        expect(activeTab.closest('[role="presentation"]')?.className).toContain("h-7");
        expect(activeTab.closest('[role="presentation"]')?.className).toContain("rounded-md");
        expect(activeTab.closest('[role="presentation"]')?.className).toContain("bg-fg-overlay-2");
        expect(inactiveTab.closest('[role="presentation"]')?.className).toContain("hover:bg-fg-overlay-1");
    });

    it("subscribes when a runtime is registered after the strip renders", async () => {
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const runtime = new FakeRuntime();
        render(
            <TopTabStrip
                tabs={Tabs.slice(0, 1)}
                activeTopTabId="file-1"
                registry={registry}
                onActivate={vi.fn()}
                onClose={vi.fn().mockResolvedValue(true)}
                onReorder={vi.fn()}
            />
        );

        act(() => {
            registry.getOrCreate("file-1", () => runtime);
            runtime.emit({ dirty: true, title: "late.ts", status: "ready" });
        });

        await vi.waitFor(() => expect(screen.getByRole("tab", { name: "late.ts, unsaved changes" })).toBeTruthy());
    });

    it.each([
        ["cancelled", vi.fn().mockResolvedValue(false)],
        ["rejected", vi.fn().mockRejectedValue(new Error("close failed"))],
    ])("retains the runtime when close is %s", async (_case, close) => {
        const registry = new WorkspaceTopTabRuntimeRegistry();
        const runtime = new FakeRuntime();
        registry.getOrCreate("file-1", () => runtime);
        render(
            <TopTabStrip
                tabs={Tabs.slice(0, 1)}
                activeTopTabId="file-1"
                registry={registry}
                onActivate={vi.fn()}
                onClose={close}
                onReorder={vi.fn()}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Close app.ts" }));
        await vi.waitFor(() => expect(close).toHaveBeenCalledWith("file-1"));

        expect(registry.get("file-1")).toBe(runtime);
        expect(runtime.dispose).not.toHaveBeenCalled();
    });
});
