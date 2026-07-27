// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCommandCard } from "./agent-command-card";
import { AgentSurfaceActivityProvider, makeAgentSurfaceActivityController } from "./agent-surface-activity";

const session: AgentSessionMeta = { path: "/sessions/agent.json", cwd: "/repo", createdAt: "2026-07-25T00:00:00Z" };

function makeSnapshot(overrides: Partial<AgentPtySnapshot> = {}): AgentPtySnapshot {
    return {
        commandId: "cmd-1",
        command: "npm test",
        cwd: "/repo",
        tail: "ready",
        screen: {
            rows: [
                { text: "ready", cells: [{ char: "r" }, { char: "e" }, { char: "a" }, { char: "d" }, { char: "y" }] },
            ],
            cursor: { row: 0, col: 4, visible: true, shape: "block", blink: false },
            isAltScreenActive: false,
        },
        running: true,
        cols: 80,
        rows: 24,
        needsUserInput: true,
        ...overrides,
    };
}

function makeClient() {
    return {
        commandRead: vi.fn(),
        commandWrite: vi.fn().mockResolvedValue(undefined),
        commandResize: vi.fn().mockResolvedValue(undefined),
        commandStop: vi.fn().mockResolvedValue(undefined),
    } as any;
}

afterEach(() => cleanup());

describe("AgentCommandCard", () => {
    it("reports measured visible screen dimensions instead of echoing stale snapshot size", async () => {
        const client = makeClient();
        const originalRect = HTMLElement.prototype.getBoundingClientRect;
        HTMLElement.prototype.getBoundingClientRect = vi.fn(
            () =>
                ({
                    x: 0,
                    y: 0,
                    top: 0,
                    left: 0,
                    right: 160,
                    bottom: 60,
                    width: 160,
                    height: 60,
                    toJSON: () => ({}),
                }) as DOMRect
        );
        try {
            render(
                <AgentCommandCard client={client} session={session} snapshot={makeSnapshot({ cols: 80, rows: 24 })} />
            );

            await waitFor(() => expect(client.commandResize).toHaveBeenCalledWith(session, "cmd-1", 20, 3));
            expect(client.commandResize).not.toHaveBeenCalledWith(session, "cmd-1", 80, 24);
        } finally {
            HTMLElement.prototype.getBoundingClientRect = originalRect;
        }
    });

    it("accepts input and stop through the workspace Agent client without Terminal tabs", () => {
        const client = makeClient();
        render(<AgentCommandCard client={client} session={session} snapshot={makeSnapshot()} />);

        expect(screen.getByTestId("agent-command-card").getAttribute("data-needs-user-input")).toBe("true");
        fireEvent.change(screen.getByLabelText("Command input"), { target: { value: "yes" } });
        fireEvent.keyDown(screen.getByLabelText("Command input"), { key: "Enter" });
        fireEvent.click(screen.getByRole("button", { name: "Stop command" }));

        expect(client.commandWrite).toHaveBeenCalledWith(session, "cmd-1", "yes\n");
        expect(client.commandStop).toHaveBeenCalledWith(session, "cmd-1");
    });

    it("changes PTY resource activity without rerendering the command card", () => {
        const client = makeClient();
        const activity = makeAgentSurfaceActivityController(true);
        const renderProbe = vi.fn();

        function Probe() {
            renderProbe();
            return <AgentCommandCard client={client} session={session} snapshot={makeSnapshot()} />;
        }

        render(
            <AgentSurfaceActivityProvider controller={activity}>
                <Probe />
            </AgentSurfaceActivityProvider>
        );
        expect(renderProbe).toHaveBeenCalledTimes(1);

        act(() => activity.setActive(false));
        expect(renderProbe).toHaveBeenCalledTimes(1);

        fireEvent.change(screen.getByLabelText("Command input"), { target: { value: "yes" } });
        fireEvent.keyDown(screen.getByLabelText("Command input"), { key: "Enter" });
        fireEvent.click(screen.getByRole("button", { name: "Stop command" }));

        expect(client.commandWrite).not.toHaveBeenCalled();
        expect(client.commandStop).not.toHaveBeenCalled();
        expect(renderProbe).toHaveBeenCalledTimes(1);
    });

    it("disconnects and reconnects PTY measurement without rerendering", () => {
        const originalResizeObserver = globalThis.ResizeObserver;
        const instances: Array<{ observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }> = [];
        class MockResizeObserver {
            observe = vi.fn();
            disconnect = vi.fn();

            constructor(_callback: ResizeObserverCallback) {
                instances.push(this);
            }
        }
        globalThis.ResizeObserver = MockResizeObserver as any;
        const activity = makeAgentSurfaceActivityController(true);
        const renderProbe = vi.fn();
        const client = makeClient();

        function Probe() {
            renderProbe();
            return <AgentCommandCard client={client} session={session} snapshot={makeSnapshot()} />;
        }

        try {
            render(
                <AgentSurfaceActivityProvider controller={activity}>
                    <Probe />
                </AgentSurfaceActivityProvider>
            );
            expect(instances).toHaveLength(1);

            act(() => activity.setActive(false));
            expect(instances[0].disconnect).toHaveBeenCalledOnce();

            act(() => activity.setActive(true));
            expect(instances).toHaveLength(2);
            expect(renderProbe).toHaveBeenCalledTimes(1);
        } finally {
            globalThis.ResizeObserver = originalResizeObserver;
        }
    });
});
