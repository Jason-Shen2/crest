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
            listRewindPoints: vi.fn(async () => ({ points: [], semanticLeafId: null, displayLeafId: null })),
            getTurnChangeSummary: vi.fn(async () => ({})),
            getTurnFileDiff: vi.fn(async () => ({})),
            reviewTurnChanges: vi.fn(async () => ({})),
            previewTurnUndo: vi.fn(async () => ({})),
            applyTurnUndo: vi.fn(async () => ({})),
            previewTurnRedo: vi.fn(async () => ({})),
            applyTurnRedo: vi.fn(async () => ({})),
            previewRewind: vi.fn(async () => ({})),
            rewindTree: vi.fn(async () => ({})),
            redoRewind: vi.fn(async () => ({})),
            getWorkspaceRecovery: vi.fn(async () => undefined),
            resolveWorkspaceRecovery: vi.fn(async () => undefined),
            cleanupWorkspaceCheckpoints: vi.fn(async () => ({})),
            listCheckpointStorageOwners: vi.fn(async () => ({ trashOwners: [] })),
            purgeTrashedSession: vi.fn(async () => ({})),
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
        await client.listRewindPoints({ sessionMetadata: { path: "/session" } } as never);
        await client.getTurnChangeSummary({ sessionMetadata: { path: "/session" } } as never);
        await client.getTurnFileDiff({ sessionMetadata: { path: "/session" } } as never);
        await client.reviewTurnChanges({ sessionMetadata: { path: "/session" } } as never);
        await client.previewTurnUndo({ sessionMetadata: { path: "/session" } } as never);
        await client.applyTurnUndo({ sessionMetadata: { path: "/session" } } as never);
        await client.previewTurnRedo({ sessionMetadata: { path: "/session" } } as never);
        await client.applyTurnRedo({ sessionMetadata: { path: "/session" } } as never);
        await client.previewRewind({ sessionMetadata: { path: "/session" } } as never);
        await client.rewindTree({ sessionMetadata: { path: "/session" } } as never);
        await client.redoRewind({ sessionMetadata: { path: "/session" } } as never);
        await client.getWorkspaceRecovery({ sessionMetadata: { path: "/session" } } as never);
        await client.resolveWorkspaceRecovery({ sessionMetadata: { path: "/session" } } as never);
        await client.cleanupWorkspaceCheckpoints({ sessionMetadata: { path: "/session" } } as never);
        await client.listCheckpointStorageOwners({ sessionMetadata: { path: "/session" } } as never);
        await client.purgeTrashedSession({ sessionMetadata: { path: "/session" } } as never);
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
        expect(agent.listRewindPoints).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.getTurnChangeSummary).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.getTurnFileDiff).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.reviewTurnChanges).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.previewTurnUndo).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.applyTurnUndo).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.previewTurnRedo).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.applyTurnRedo).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.previewRewind).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.rewindTree).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.redoRewind).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.getWorkspaceRecovery).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.resolveWorkspaceRecovery).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.cleanupWorkspaceCheckpoints).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.listCheckpointStorageOwners).toHaveBeenCalledWith(identity, expect.any(Object));
        expect(agent.purgeTrashedSession).toHaveBeenCalledWith(identity, expect.any(Object));
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

    it("forwards only session identity, recovery action, and opaque purge ownership fields", async () => {
        const agent = {
            getWorkspaceRecovery: vi.fn(async () => undefined),
            resolveWorkspaceRecovery: vi.fn(async () => undefined),
            cleanupWorkspaceCheckpoints: vi.fn(async () => ({
                removedUnownedBytes: 0,
                quota: {
                    status: "referenced-over-quota",
                    usedBytes: 20,
                    softQuotaBytes: 10,
                    cleanupAvailable: true,
                },
            })),
            listCheckpointStorageOwners: vi.fn(async () => ({ trashOwners: [] })),
            purgeTrashedSession: vi.fn(async () => ({
                purgedSessionId: "trash-a",
                quota: {
                    status: "ok",
                    usedBytes: 0,
                    softQuotaBytes: 10,
                    cleanupAvailable: false,
                },
            })),
        };
        const identity = { workspaceId: "workspace-17", generation: 17 };
        const sessionMetadata = { id: "session-a", path: "/sessions/a.db", cwd: "/repo" } as AgentSessionMeta;
        const client = new AgentRuntimeClient(agent as never, identity);

        await client.getWorkspaceRecovery({ sessionMetadata });
        await client.resolveWorkspaceRecovery({
            sessionMetadata,
            operationId: "operation-a",
            action: "retry",
            paths: ["src/renderer-must-not-send.ts"],
            phase: "applying_files",
            refName: "refs/crest/ops/renderer-must-not-send",
        } as never);
        await client.cleanupWorkspaceCheckpoints({ sessionMetadata });
        await client.listCheckpointStorageOwners({ sessionMetadata });
        await client.purgeTrashedSession({
            sessionMetadata,
            trashedSessionId: "trash-a",
            confirmationToken: "opaque-token",
            databasePath: "/sessions/.trash/a.db",
            refName: "refs/crest/snapshots/renderer-must-not-send",
        } as never);

        expect(agent.getWorkspaceRecovery).toHaveBeenCalledWith(identity, { sessionMetadata });
        expect(agent.resolveWorkspaceRecovery).toHaveBeenCalledWith(identity, {
            sessionMetadata,
            operationId: "operation-a",
            action: "retry",
        });
        expect(agent.cleanupWorkspaceCheckpoints).toHaveBeenCalledWith(identity, { sessionMetadata });
        expect(agent.listCheckpointStorageOwners).toHaveBeenCalledWith(identity, { sessionMetadata });
        expect(agent.purgeTrashedSession).toHaveBeenCalledWith(identity, {
            sessionMetadata,
            trashedSessionId: "trash-a",
            confirmationToken: "opaque-token",
        });
        expect(JSON.stringify(agent.resolveWorkspaceRecovery.mock.calls)).not.toMatch(/phase|paths|classifier|refName/);
        expect(JSON.stringify(agent.purgeTrashedSession.mock.calls)).not.toMatch(/databasePath|refName|refs\/crest/);
    });
});
