// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { globalStore } from "@/app/store/jotaiStore";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider, atom } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionsPanel } from "./agent-sessions-panel";

const contextMenu = vi.hoisted(() => ({
    showContextMenu: vi.fn(),
}));

vi.mock("@/app/store/contextmenu", () => ({
    ContextMenuModel: {
        getInstance: () => contextMenu,
    },
}));

function makeSession(path: string, id = "session-1"): AgentSessionDetail {
    return {
        id,
        createdAt: "2026-07-25T10:00:00.000Z",
        cwd: "/repo",
        path,
        modifiedAt: "2026-07-25T10:05:00.000Z",
        messageCount: 1,
        firstMessage: "hello",
        previewText: "hello",
    };
}

function makeModel() {
    return {
        stateAtom: atom({
            activeSession: undefined,
            selection: undefined,
        }),
        selectSession: vi.fn(function (this: { stateAtom: ReturnType<typeof atom> }, session?: AgentSessionMeta) {
            globalStore.set(this.stateAtom, {
                ...globalStore.get(this.stateAtom),
                activeSession: session,
            });
        }),
    };
}

function renderPanel(options: { sessions?: AgentSessionDetail[] } = {}) {
    const sessions = options.sessions ?? [makeSession("/sessions/a.sqlite")];
    const runtimeClient = {
        createSession: vi.fn().mockResolvedValue({
            id: "session-new",
            createdAt: "2026-07-25T11:00:00.000Z",
            cwd: "/repo",
            path: "/sessions/new.sqlite",
        }),
        listSessionDetails: vi.fn().mockResolvedValue(sessions),
        renameSession: vi.fn().mockResolvedValue(undefined),
        archiveSession: vi.fn().mockResolvedValue({ ...sessions[0], path: "/sessions/.archive/a.sqlite" }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        abort: vi.fn().mockResolvedValue(undefined),
    };
    const agentModel = makeModel();
    const workspaceModel = {
        activateAgent: vi.fn(),
    };
    const layoutModel = {
        showLeftPanel: vi.fn(),
        toggleLeftPanel: vi.fn(),
    };

    render(
        <Provider store={globalStore}>
            <AgentSessionsPanel
                runtimeClient={runtimeClient as any}
                agentModel={agentModel as any}
                workspaceModel={workspaceModel as any}
                layoutModel={layoutModel as any}
            />
        </Provider>
    );

    return { runtimeClient, agentModel, workspaceModel, layoutModel };
}

afterEach(() => {
    cleanup();
    contextMenu.showContextMenu.mockClear();
});

describe("AgentSessionsPanel", () => {
    it("creates a workspace Agent session without opening a Wave Tab", async () => {
        const { runtimeClient, agentModel, workspaceModel, layoutModel } = renderPanel();

        fireEvent.click(screen.getByTitle("New Session"));

        await waitFor(() => expect(runtimeClient.createSession).toHaveBeenCalledOnce());
        expect(agentModel.selectSession).toHaveBeenCalledWith(
            expect.objectContaining({ path: "/sessions/new.sqlite" })
        );
        expect(workspaceModel.activateAgent).toHaveBeenCalledOnce();
        expect(layoutModel.showLeftPanel).toHaveBeenCalledWith("sessions");
    });

    it("selects an existing session through WorkspaceAgentModel", async () => {
        const session = makeSession("/sessions/current.sqlite", "session-current");
        const { agentModel, workspaceModel, layoutModel } = renderPanel({ sessions: [session] });

        await screen.findByText("hello");
        fireEvent.click(screen.getByText("hello"));

        expect(agentModel.selectSession).toHaveBeenCalledWith(
            expect.objectContaining({ path: "/sessions/current.sqlite" })
        );
        expect(workspaceModel.activateAgent).toHaveBeenCalledOnce();
        expect(layoutModel.showLeftPanel).toHaveBeenCalledWith("sessions");
    });

    it("marks the active row from WorkspaceAgentModel state", async () => {
        const session = makeSession("/sessions/current.sqlite", "session-current");
        const { agentModel } = renderPanel({ sessions: [session] });
        globalStore.set(agentModel.stateAtom, {
            activeSession: {
                id: "session-current",
                createdAt: "2026-07-25T10:00:00.000Z",
                cwd: "/repo",
                path: "/sessions/current.sqlite",
            },
            selection: undefined,
        });

        await screen.findByText("hello");

        expect(screen.getByRole("button", { name: /hello/ }).getAttribute("data-active")).toBe("true");
    });

    it("uses compact neutral styles for active, focused, and default rows", async () => {
        const sessions = [
            makeSession("/sessions/active.sqlite", "session-active"),
            makeSession("/sessions/other.sqlite", "session-other"),
        ];
        const { agentModel } = renderPanel({ sessions });
        globalStore.set(agentModel.stateAtom, {
            activeSession: {
                id: "session-active",
                createdAt: "2026-07-25T10:00:00.000Z",
                cwd: "/repo",
                path: "/sessions/active.sqlite",
            },
            selection: undefined,
        });

        const rows = await screen.findAllByRole("button", { name: /hello/ });
        const activeRow = rows[0];
        const otherRow = rows[1];
        const list = document.querySelector(".aui-thread-list");

        expect(list?.className).toContain("p-2");
        expect(activeRow.className).toContain("min-h-[34px]");
        expect(activeRow.className).toContain("rounded-md");
        expect(activeRow.className).toContain("bg-sidebar-accent");
        expect(activeRow.className).toContain("text-sidebar-accent-foreground");
        expect(activeRow.className).not.toContain("bg-white");
        expect(activeRow.className).not.toContain("bg-transparent");

        fireEvent.mouseEnter(otherRow);

        expect(otherRow.className).toContain("bg-sidebar-accent/70");
        expect(otherRow.className).not.toContain("bg-white");
        expect(otherRow.className).not.toContain("bg-transparent");
    });

    it("offers session management actions in the row context menu", async () => {
        renderPanel();

        await screen.findByText("hello");
        fireEvent.contextMenu(screen.getByRole("button", { name: /hello/ }));

        expect(contextMenu.showContextMenu).toHaveBeenCalledOnce();
        const labels = contextMenu.showContextMenu.mock.calls[0][0].map((item: ContextMenuItem) => item.label);
        expect(labels).toEqual(["Rename", "Archive", "Delete", "Stop Run"]);
    });

    it("renames a session through the runtime client and reloads the list", async () => {
        const { runtimeClient } = renderPanel();
        vi.stubGlobal("prompt", vi.fn(() => "Better name"));

        await screen.findByText("hello");
        fireEvent.contextMenu(screen.getByRole("button", { name: /hello/ }));
        await contextMenu.showContextMenu.mock.calls[0][0][0].click();

        expect(runtimeClient.renameSession).toHaveBeenCalledWith(
            expect.objectContaining({ path: "/sessions/a.sqlite" }),
            "Better name"
        );
        expect(runtimeClient.listSessionDetails).toHaveBeenCalledTimes(2);
    });

    it("archive and delete clear a matching active session", async () => {
        const session = makeSession("/sessions/current.sqlite", "session-current");
        const { agentModel, runtimeClient } = renderPanel({ sessions: [session] });
        globalStore.set(agentModel.stateAtom, {
            activeSession: {
                id: "session-current",
                createdAt: "2026-07-25T10:00:00.000Z",
                cwd: "/repo",
                path: "/sessions/current.sqlite",
            },
            selection: { provider: "p", model: "m" } as AgentSelectionMeta,
        });

        await screen.findByText("hello");
        fireEvent.contextMenu(screen.getByRole("button", { name: /hello/ }));
        await contextMenu.showContextMenu.mock.calls[0][0][1].click();

        expect(runtimeClient.archiveSession).toHaveBeenCalledWith(
            expect.objectContaining({ path: "/sessions/current.sqlite" })
        );
        expect(globalStore.get(agentModel.stateAtom)).toMatchObject({
            activeSession: undefined,
            selection: { provider: "p", model: "m" },
        });

        agentModel.selectSession({
            id: "session-current",
            createdAt: "2026-07-25T10:00:00.000Z",
            cwd: "/repo",
            path: "/sessions/current.sqlite",
        });
        fireEvent.contextMenu(screen.getByRole("button", { name: /hello/ }));
        await contextMenu.showContextMenu.mock.calls[1][0][2].click();

        expect(runtimeClient.deleteSession).toHaveBeenCalledWith(
            expect.objectContaining({ path: "/sessions/current.sqlite" })
        );
        expect(globalStore.get(agentModel.stateAtom).activeSession).toBeUndefined();
    });
});
