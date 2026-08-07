// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AgentHarness, AgentHarnessEvent, Session, SessionTreeEntry } from "@crest/agent/harness/types";
import { SessionMutationBarrier } from "../session-mutation-barrier";
import { registerWorkspaceCheckpointManager, type WorkspaceCheckpointManagerDependencies } from "./checkpoint-manager";
import type { ProcessOwnerIdentity } from "./process-owner";
import type { WorkspaceCheckpointSnapshotSource } from "./snapshot-source";
import { WorkspaceSnapshotStoreError } from "./snapshot-store";
import { WorkspaceControlCustomTypes, type WorkspaceSnapshotCoverage, type WorkspaceSnapshotRefV1 } from "./types";

const OidA = "a".repeat(40);
const OidB = "b".repeat(40);
const OidC = "c".repeat(40);
const Owner: ProcessOwnerIdentity = { pid: 42, processStartToken: "start-1", nonce: "nonce-1" };

function snapshot(id: string): WorkspaceSnapshotRefV1 {
    return {
        id,
        workspaceIdentity: "workspace-1",
        workspaceIncarnation: "incarnation-1",
        tree: OidB,
        scopeManifest: OidC,
    };
}

const Coverage: WorkspaceSnapshotCoverage = {
    complete: true,
    eligibleEntryCount: 1,
    newlyHashedBytes: 0,
    exclusions: [],
};

function makeFixture(options: { hosted?: boolean } = {}) {
    const listeners = new Set<(event: AgentHarnessEvent) => void | Promise<void>>();
    const harness = {
        subscribe(listener: (event: AgentHarnessEvent) => void | Promise<void>) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    } as unknown as AgentHarness;
    let leafId: string | null = null;
    const entries: SessionTreeEntry[] = [];
    const session = {
        getLeafId: vi.fn(async () => leafId),
        getEntries: vi.fn(async () => [...entries]),
        appendEntries: vi.fn(async (next: SessionTreeEntry[], appendOptions?: { expectedLeafId?: string | null }) => {
            expect(appendOptions).toEqual({ expectedLeafId: leafId });
            entries.push(...next);
            leafId = next.at(-1)?.id ?? leafId;
        }),
    } as unknown as Session;
    const base = snapshot(OidA);
    const after = snapshot(OidB);
    const source: WorkspaceCheckpointSnapshotSource = {
        readHead: vi.fn(async () => ({ ref: base, coverage: Coverage })),
        synchronizeExternal: vi.fn(async () => ({ ref: base, coverage: Coverage })),
        captureOwnedTurn: vi.fn(async () => ({
            after,
            coverage: Coverage,
            changes: [
                {
                    path: "changed.txt",
                    before: { state: "absent" as const },
                    after: { state: "file" as const, oid: OidC, executable: false },
                },
            ],
        })),
    };
    const release = vi.fn();
    const writerLeases = {
        acquire: vi.fn(async (input) => ({
            workspaceKey: input.workspaceKey,
            sessionId: input.sessionId,
            boundaryToken: input.boundaryToken,
            release,
        })),
    };
    const pending = {
        begin: vi.fn(),
        bind: vi.fn(),
        recordAfter: vi.fn(),
        complete: vi.fn(),
        retireUnavailable: vi.fn(async () => undefined),
        retireUnbound: vi.fn(),
        retireRecoveredUnbound: vi.fn(async () => undefined),
        recover: vi.fn(async () => []),
    };
    const dependencies: WorkspaceCheckpointManagerDependencies = {
        pendingStore: pending as never,
        writerLeases: writerLeases as never,
        now: () => "2026-08-08T00:00:00.000Z",
    };
    const onCheckpointCommitted = vi.fn(async () => undefined);
    const manager = registerWorkspaceCheckpointManager({
        harness,
        session,
        sessionId: "session-1",
        workspaceRoot: "/workspace",
        store: {
            identity: {
                workspaceIdentity: "workspace-1",
                workspaceIncarnation: "incarnation-1",
            },
        } as never,
        snapshotSource: source,
        mutationBarrier: new SessionMutationBarrier(),
        hasRunningHostedCommands: () => options.hosted ?? false,
        processOwner: Owner,
        onCheckpointCommitted,
        dependencies,
    });
    return {
        manager,
        source,
        writerLeases,
        release,
        pending,
        entries,
        onCheckpointCommitted,
        async emit(event: AgentHarnessEvent) {
            for (const listener of listeners) await listener(event);
        },
    };
}

async function startBoundary(fixture: ReturnType<typeof makeFixture>, token = "boundary-1"): Promise<void> {
    await fixture.emit({
        type: "session_before_user_turn",
        boundaryToken: token,
        userMessage: { role: "user", content: [] },
    } as AgentHarnessEvent);
}

async function bindBoundary(
    fixture: ReturnType<typeof makeFixture>,
    token = "boundary-1",
    userEntryId = "user-1"
): Promise<void> {
    await fixture.emit({
        type: "session_user_turn_committed",
        boundaryToken: token,
        userEntryId,
    } as AgentHarnessEvent);
}

async function finishBoundary(fixture: ReturnType<typeof makeFixture>, token = "boundary-1"): Promise<void> {
    await fixture.emit({
        type: "session_user_turn_terminal",
        boundaryToken: token,
        reason: "agent_end",
    } as AgentHarnessEvent);
}

describe("WorkspaceCheckpointManager", () => {
    it("creates boundary metadata without scanning, capturing, leasing, or persisting pending state", async () => {
        const fixture = makeFixture();

        await startBoundary(fixture);

        expect(fixture.source.readHead).not.toHaveBeenCalled();
        expect(fixture.source.synchronizeExternal).not.toHaveBeenCalled();
        expect(fixture.source.captureOwnedTurn).not.toHaveBeenCalled();
        expect(fixture.writerLeases.acquire).not.toHaveBeenCalled();
        expect(fixture.pending.begin).not.toHaveBeenCalled();
    });

    it("writes one no-tool checkpoint from one authoritative head read without a physical capture", async () => {
        const fixture = makeFixture();
        await startBoundary(fixture);
        await bindBoundary(fixture);

        await finishBoundary(fixture);

        expect(fixture.source.readHead).toHaveBeenCalledOnce();
        expect(fixture.source.synchronizeExternal).not.toHaveBeenCalled();
        expect(fixture.source.captureOwnedTurn).not.toHaveBeenCalled();
        expect(fixture.writerLeases.acquire).not.toHaveBeenCalled();
        expect(fixture.entries).toHaveLength(1);
        expect(fixture.entries[0]).toMatchObject({
            type: "custom",
            customType: WorkspaceControlCustomTypes.checkpoint,
            data: {
                status: "available",
                turnId: "user-1",
                before: { id: OidA },
                after: { id: OidA },
                changes: [],
            },
        });
    });

    it.each(["read", "grep", "find", "ls", "web_fetch"])("keeps the safe %s tool lease-free", async (toolName) => {
        const fixture = makeFixture();
        await startBoundary(fixture);

        await fixture.manager.beforeWorkspaceTool(toolName);

        expect(fixture.writerLeases.acquire).not.toHaveBeenCalled();
        expect(fixture.source.synchronizeExternal).not.toHaveBeenCalled();
    });

    it("acquires once for the first writing tool and treats unknown future tools as write-capable", async () => {
        const fixture = makeFixture();
        await startBoundary(fixture);

        await fixture.manager.beforeWorkspaceTool("future_workspace_mutator");
        await fixture.manager.beforeWorkspaceTool("edit");

        expect(fixture.writerLeases.acquire).toHaveBeenCalledOnce();
        expect(fixture.writerLeases.acquire).toHaveBeenCalledWith({
            workspaceKey: "workspace-1:incarnation-1",
            sessionId: "session-1",
            boundaryToken: "boundary-1",
            signal: expect.any(AbortSignal),
        });
        expect(fixture.source.synchronizeExternal).toHaveBeenCalledOnce();
    });

    it("captures exactly one owned turn result and releases its writer lease at terminal", async () => {
        const fixture = makeFixture();
        await startBoundary(fixture);
        await bindBoundary(fixture);
        await fixture.manager.beforeWorkspaceTool("bash");

        expect(fixture.pending.begin).toHaveBeenCalledWith(
            expect.objectContaining({
                boundaryToken: "boundary-1",
                sessionId: "session-1",
                before: expect.objectContaining({ id: OidA }),
            })
        );
        expect(fixture.pending.bind).toHaveBeenCalledWith("boundary-1", "user-1");

        await finishBoundary(fixture);

        expect(fixture.source.captureOwnedTurn).toHaveBeenCalledWith({
            base: expect.objectContaining({ id: OidA }),
            sessionId: "session-1",
            turnId: "user-1",
        });
        expect(fixture.release).toHaveBeenCalledOnce();
        expect(fixture.pending.recordAfter).toHaveBeenCalledWith("boundary-1", expect.objectContaining({ id: OidB }));
        expect(fixture.pending.complete).toHaveBeenCalledWith("boundary-1");
        expect(fixture.entries.at(-1)).toMatchObject({
            data: {
                status: "available",
                before: { id: OidA },
                after: { id: OidB },
                changes: [{ path: "changed.txt" }],
            },
        });
    });

    it("releases the writer lease when terminal capture fails", async () => {
        const fixture = makeFixture();
        vi.mocked(fixture.source.captureOwnedTurn).mockRejectedValueOnce(
            new WorkspaceSnapshotStoreError("capture_timeout", "deadline")
        );
        await startBoundary(fixture);
        await bindBoundary(fixture);
        await fixture.manager.beforeWorkspaceTool("bash");

        await expect(finishBoundary(fixture)).resolves.toBeUndefined();

        expect(fixture.release).toHaveBeenCalledOnce();
        expect(fixture.pending.retireUnavailable).toHaveBeenCalledWith("boundary-1");
        expect(fixture.entries.at(-1)).toMatchObject({
            data: { status: "unavailable", turnId: "user-1", reasonCode: "capture_timeout" },
        });
    });

    it("releases an acquired writer lease when preparation terminates before the user entry commits", async () => {
        const fixture = makeFixture();
        await startBoundary(fixture);
        await fixture.manager.beforeWorkspaceTool("bash");

        await finishBoundary(fixture);

        expect(fixture.entries).toHaveLength(0);
        expect(fixture.release).toHaveBeenCalledOnce();
    });

    it("keeps a detached hosted command unavailable while still releasing the writer lease", async () => {
        const fixture = makeFixture({ hosted: true });
        await startBoundary(fixture);
        await bindBoundary(fixture);
        await fixture.manager.beforeHostedCommand();

        await finishBoundary(fixture);

        expect(fixture.source.captureOwnedTurn).not.toHaveBeenCalled();
        expect(fixture.release).toHaveBeenCalledOnce();
        expect(fixture.entries.at(-1)).toMatchObject({
            data: { status: "unavailable", reasonCode: "hosted_pty_running" },
        });
    });

    it("releases a held writer lease during disposal", async () => {
        const fixture = makeFixture();
        await startBoundary(fixture);
        await fixture.manager.beforeWorkspaceTool("bash");

        await fixture.manager.dispose();

        expect(fixture.release).toHaveBeenCalledOnce();
        expect(fixture.pending.retireUnbound).toHaveBeenCalledWith("boundary-1", Owner);
    });

    it("retires a bound pending record during graceful disposal", async () => {
        const fixture = makeFixture();
        await startBoundary(fixture);
        await bindBoundary(fixture);
        await fixture.manager.beforeWorkspaceTool("bash");

        await fixture.manager.dispose();

        expect(fixture.pending.retireUnavailable).toHaveBeenCalledWith("boundary-1");
        expect(fixture.release).toHaveBeenCalledOnce();
    });

    it("still releases the writer lease when graceful pending cleanup fails", async () => {
        const fixture = makeFixture();
        const cleanupFailure = new Error("pending cleanup failed");
        fixture.pending.retireUnavailable.mockRejectedValueOnce(cleanupFailure);
        await startBoundary(fixture);
        await bindBoundary(fixture);
        await fixture.manager.beforeWorkspaceTool("bash");

        await expect(fixture.manager.dispose()).rejects.toBe(cleanupFailure);

        expect(fixture.release).toHaveBeenCalledOnce();
    });

    it("fails closed when a workspace-capable tool has no active user-turn boundary", async () => {
        const fixture = makeFixture();

        await expect(fixture.manager.beforeWorkspaceTool("bash")).rejects.toThrow(/active user-turn boundary/i);

        expect(fixture.writerLeases.acquire).not.toHaveBeenCalled();
    });

    it("releases acquisition and records unavailable when external synchronization fails", async () => {
        const fixture = makeFixture();
        vi.mocked(fixture.source.synchronizeExternal).mockRejectedValueOnce(
            new WorkspaceSnapshotStoreError("unstable_file", "Workspace did not settle")
        );
        await startBoundary(fixture);
        await bindBoundary(fixture);

        await expect(fixture.manager.beforeWorkspaceTool("bash")).rejects.toThrow(/did not settle/);
        await finishBoundary(fixture);

        expect(fixture.release).toHaveBeenCalledOnce();
        expect(fixture.entries.at(-1)).toMatchObject({
            data: { status: "unavailable", reasonCode: "unstable_file" },
        });
    });

    it("retires an unbound pending record when its immediate user-entry bind fails", async () => {
        const fixture = makeFixture();
        fixture.pending.bind.mockRejectedValueOnce(new Error("bind failed"));
        await startBoundary(fixture);
        await bindBoundary(fixture);

        await expect(fixture.manager.beforeWorkspaceTool("bash")).rejects.toThrow("bind failed");

        expect(fixture.release).toHaveBeenCalledOnce();
        expect(fixture.pending.retireUnbound).toHaveBeenCalledWith("boundary-1", Owner);
        await expect(finishBoundary(fixture)).resolves.toBeUndefined();
        expect(fixture.pending.retireUnavailable).not.toHaveBeenCalled();
        expect(fixture.source.captureOwnedTurn).not.toHaveBeenCalled();
        expect(fixture.entries.at(-1)).toMatchObject({
            data: { status: "unavailable", turnId: "user-1" },
        });
    });

    it("retains dead-owner recovery for legacy pending boundaries without creating new ones", async () => {
        const fixture = makeFixture();
        fixture.pending.recover.mockResolvedValueOnce([
            {
                record: {
                    boundaryToken: "boundary-crash",
                    sessionId: "session-1",
                    workspaceIdentity: "workspace-1",
                    workspaceIncarnation: "incarnation-1",
                    processOwner: Owner,
                    nonce: "nonce-boundary",
                    before: snapshot(OidA),
                    userEntryId: "user-crash",
                },
                disposition: "resume-finalization",
            },
        ]);

        await fixture.manager.recover();

        expect(fixture.entries.at(-1)).toMatchObject({
            data: {
                status: "unavailable",
                turnId: "user-crash",
                reasonCode: "process_crash_before_finalization",
            },
        });
        expect(fixture.pending.retireUnavailable).toHaveBeenCalledWith("boundary-crash");
        expect(fixture.pending.begin).not.toHaveBeenCalled();
    });
});
