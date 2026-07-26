// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const shortcuts = vi.hoisted(() => ({
    registerWorkspaceKeyLifecycle: vi.fn(),
}));

vi.mock("@/app/store/keymodel", () => shortcuts);

vi.mock("@/app/tab/tabcontent", async () => {
    const { useTabModel } = await import("@/app/store/tab-model");
    const { useDragLayer } = await import("react-dnd");
    return {
        TabContent: ({ tabId }: { tabId: string }) => {
            const model = useTabModel();
            useDragLayer((monitor) => monitor.isDragging());
            return <div data-testid="terminal-content">{`${tabId}:${model.tabId}`}</div>;
        },
    };
});

vi.mock("@/app/waveenv/waveenvimpl", () => ({
    makeWaveEnvImpl: () => ({ isMock: false }),
}));

const TerminalAppModulePath = "./terminal-app";

afterEach(cleanup);

describe("TerminalApp", () => {
    it("mounts TabContent under the matching TabModelContext", async () => {
        const { TerminalApp } = await import(TerminalAppModulePath);

        render(<TerminalApp tabId="terminal-1" onFirstRender={vi.fn()} />);

        expect(screen.getByTestId("terminal-content").textContent).toBe("terminal-1:terminal-1");
        expect(screen.getByTestId("terminal-renderer-root").className).toBe(
            "flex h-full w-full min-h-0 overflow-hidden"
        );
        expect(screen.queryByTestId("top-bar")).toBeNull();
        expect(screen.queryByTestId("workspace-left-panel")).toBeNull();
        expect(screen.queryByTestId("workspace-right-panel")).toBeNull();
        expect(screen.queryByTestId("agent-placeholder")).toBeNull();
        expect(screen.queryByTestId("status-bar")).toBeNull();
        expect(shortcuts.registerWorkspaceKeyLifecycle).not.toHaveBeenCalled();
    });

    it("renders an empty state without constructing Terminal content for an empty tab identity", async () => {
        const { TerminalApp } = await import(TerminalAppModulePath);

        render(<TerminalApp tabId="" onFirstRender={vi.fn()} />);

        expect(screen.getByTestId("terminal-empty-state")).not.toBeNull();
        expect(screen.getByTestId("terminal-renderer-root").className).toBe(
            "flex h-full w-full min-h-0 overflow-hidden"
        );
        expect(screen.queryByTestId("terminal-content")).toBeNull();
    });
});
