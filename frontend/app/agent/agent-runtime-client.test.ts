// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { AgentRuntimeClient } from "./agent-runtime-client";

describe("AgentRuntimeClient", () => {
    it("injects its immutable workspace identity into every request", async () => {
        const agent = {
            createSession: vi.fn(async () => ({ path: "/session" })),
            listSessions: vi.fn(async () => []),
            listSessionDetails: vi.fn(async () => []),
            listCommands: vi.fn(async () => []),
            getSessionState: vi.fn(async () => ({})),
            listTree: vi.fn(async () => ({ entries: [], leafId: null })),
            listForkPoints: vi.fn(async () => []),
            navigateTree: vi.fn(async () => ({})),
            forkSession: vi.fn(async () => ({})),
            cloneSession: vi.fn(async () => ({})),
            runCommand: vi.fn(async () => ({})),
            commandRead: vi.fn(async () => ({})),
            commandWrite: vi.fn(async () => {}),
            commandResize: vi.fn(async () => {}),
            commandStop: vi.fn(async () => {}),
            renameSession: vi.fn(async () => {}),
            archiveSession: vi.fn(async () => ({ path: "/session/.archive/session.db" })),
            deleteSession: vi.fn(async () => {}),
            send: vi.fn(async () => ({})),
            abort: vi.fn(async () => {}),
            subscribe: vi.fn(() => () => {}),
        };
        const client = new AgentRuntimeClient(agent as never, { workspaceId: "workspace-1", generation: 7 });

        await client.createSession();
        await client.listSessions();
        await client.listSessionDetails(5);
        await client.listCommands();
        await client.getSessionState({ path: "/session" } as AgentSessionMeta);
        await client.listTree({ path: "/session" } as AgentSessionMeta);
        await client.listForkPoints({ path: "/session" } as AgentSessionMeta);
        await client.navigateTree({ sessionMetadata: { path: "/session" }, targetId: "entry" } as never);
        await client.forkSession({ sessionMetadata: { path: "/session" }, entryId: "entry" } as never);
        await client.cloneSession({ sessionMetadata: { path: "/session" } } as never);
        await client.runCommand({ command: "new", argsText: "" } as never);
        await client.commandRead({ path: "/session" } as AgentSessionMeta, "cmd-1");
        await client.commandWrite({ path: "/session" } as AgentSessionMeta, "cmd-1", "yes\n");
        await client.commandResize({ path: "/session" } as AgentSessionMeta, "cmd-1", 80, 24);
        await client.commandStop({ path: "/session" } as AgentSessionMeta, "cmd-1");
        await client.renameSession({ path: "/session" } as AgentSessionMeta, "Better name");
        await client.archiveSession({ path: "/session" } as AgentSessionMeta);
        await client.deleteSession({ path: "/session" } as AgentSessionMeta);
        await client.send({ text: "hello" } as never);
        await client.abort("/session");
        client.subscribe("/session", vi.fn());

        const identity = { workspaceId: "workspace-1", generation: 7 };
        expect(agent.createSession).toHaveBeenCalledWith(identity);
        expect(agent.listSessions).toHaveBeenCalledWith(identity);
        expect(agent.listSessionDetails).toHaveBeenCalledWith(identity, 5);
        expect(agent.listCommands).toHaveBeenCalledWith(identity);
        expect(agent.getSessionState).toHaveBeenCalledWith(identity, expect.objectContaining({ path: "/session" }));
        expect(agent.listTree).toHaveBeenCalledWith(identity, expect.objectContaining({ path: "/session" }));
        expect(agent.listForkPoints).toHaveBeenCalledWith(identity, expect.objectContaining({ path: "/session" }));
        expect(agent.navigateTree).toHaveBeenCalledWith(identity, expect.objectContaining({ targetId: "entry" }));
        expect(agent.forkSession).toHaveBeenCalledWith(identity, expect.objectContaining({ entryId: "entry" }));
        expect(agent.cloneSession).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.runCommand).toHaveBeenCalledWith(identity, expect.objectContaining({ command: "new" }));
        expect(agent.commandRead).toHaveBeenCalledWith(identity, expect.objectContaining({ path: "/session" }), {
            commandId: "cmd-1",
        });
        expect(agent.commandWrite).toHaveBeenCalledWith(identity, expect.objectContaining({ path: "/session" }), {
            commandId: "cmd-1",
            input: "yes\n",
        });
        expect(agent.commandResize).toHaveBeenCalledWith(identity, expect.objectContaining({ path: "/session" }), {
            commandId: "cmd-1",
            cols: 80,
            rows: 24,
        });
        expect(agent.commandStop).toHaveBeenCalledWith(identity, expect.objectContaining({ path: "/session" }), {
            commandId: "cmd-1",
        });
        expect(agent.renameSession).toHaveBeenCalledWith(identity, {
            sessionMetadata: expect.objectContaining({ path: "/session" }),
            name: "Better name",
        });
        expect(agent.archiveSession).toHaveBeenCalledWith(identity, expect.objectContaining({ path: "/session" }));
        expect(agent.deleteSession).toHaveBeenCalledWith(identity, expect.objectContaining({ path: "/session" }));
        expect(agent.send).toHaveBeenCalledWith(identity, expect.objectContaining({ text: "hello" }));
        expect(agent.abort).toHaveBeenCalledWith(identity, "/session");
        expect(agent.subscribe).toHaveBeenCalledWith(identity, "/session", expect.any(Function));
        expect(Object.isFrozen(client.identity)).toBe(true);
        expect("agent" in client).toBe(false);
    });
});
