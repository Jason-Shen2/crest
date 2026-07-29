// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { AgentHarness, AgentHarnessEvent, Session, SessionTreeEntry } from "@crest/agent/harness/types";
import { SessionMutationBarrier } from "../session-mutation-barrier";
import { registerWorkspaceCheckpointManager, type WorkspaceCheckpointManagerDependencies } from "./checkpoint-manager";
import type { ProcessOwnerIdentity } from "./process-owner";
import { WorkspaceSnapshotStoreError } from "./snapshot-store";
import { WorkspaceControlCustomTypes, type WorkspaceSnapshotRefV1 } from "./types";

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

function makeFixture() {
    const listeners = new Set<(event: AgentHarnessEvent) => void | Promise<void>>();
    const order: string[] = [];
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
        appendEntries: vi.fn(async (next: SessionTreeEntry[], options?: { expectedLeafId?: string | null }) => {
            order.push("append");
            expect(options).toEqual({ expectedLeafId: leafId });
            entries.push(...next);
            leafId = next.at(-1)?.id ?? leafId;
        }),
    } as unknown as Session;
    const before = snapshot(OidA);
    const after = snapshot(OidB);
    const store = {
        identity: {
            workspaceIdentity: "workspace-1",
            workspaceIncarnation: "incarnation-1",
        },
        capture: vi
            .fn()
            .mockImplementationOnce(async (options) => {
                order.push(`capture:${options.profile}`);
                return {
                    ref: before,
                    coverage: { complete: true, eligibleEntryCount: 1, newlyHashedBytes: 1, exclusions: [] },
                };
            })
            .mockImplementationOnce(async (options) => {
                order.push(`capture:${options.profile}`);
                return {
                    ref: after,
                    coverage: { complete: true, eligibleEntryCount: 1, newlyHashedBytes: 1, exclusions: [] },
                };
            }),
        diff: vi.fn(async () => {
            order.push("diff");
            return [];
        }),
    };
    const pending = {
        begin: vi.fn(async () => order.push("pending:begin")),
        bind: vi.fn(async () => order.push("pending:bind")),
        recordAfter: vi.fn(async () => order.push("pending:after")),
        complete: vi.fn(async () => order.push("pending:complete")),
        retireUnavailable: vi.fn(async () => order.push("pending:retire-unavailable")),
        retireUnbound: vi.fn(async () => order.push("pending:retire-unbound")),
        retireRecoveredUnbound: vi.fn(async () => order.push("pending:retire-recovered-unbound")),
        recover: vi.fn(async () => []),
    };
    const dependencies: WorkspaceCheckpointManagerDependencies = {
        pendingStore: pending as never,
        now: () => "2026-07-29T00:00:00.000Z",
    };
    const onCheckpointCommitted = vi.fn(async () => {
        order.push("refresh");
    });
    const manager = registerWorkspaceCheckpointManager({
        harness,
        session,
        sessionId: "session-1",
        workspaceRoot: "/workspace",
        store: store as never,
        mutationBarrier: new SessionMutationBarrier(),
        hasRunningHostedCommands: () => false,
        processOwner: Owner,
        onCheckpointCommitted,
        dependencies,
    });
    return {
        manager,
        harness,
        order,
        store,
        pending,
        session,
        entries,
        async emit(event: AgentHarnessEvent) {
            for (const listener of listeners) {
                await listener(event);
            }
        },
    };
}

describe("WorkspaceCheckpointManager", () => {
    it("persists the exact capture, bind, terminal checkpoint, refresh, and pending removal order", async () => {
        const fixture = makeFixture();

        await fixture.emit({
            type: "session_before_user_turn",
            boundaryToken: "boundary-1",
            userMessage: { role: "user", content: [{ type: "text", text: "hello" }] },
        } as AgentHarnessEvent);
        await fixture.emit({
            type: "session_user_turn_committed",
            boundaryToken: "boundary-1",
            userEntryId: "user-1",
        } as AgentHarnessEvent);
        await fixture.emit({
            type: "session_user_turn_terminal",
            boundaryToken: "boundary-1",
            reason: "agent_end",
        } as AgentHarnessEvent);

        expect(fixture.order).toEqual([
            "capture:pre-turn",
            "pending:begin",
            "pending:bind",
            "capture:terminal",
            "pending:after",
            "diff",
            "append",
            "refresh",
            "pending:complete",
        ]);
        expect(fixture.entries).toHaveLength(1);
        expect(fixture.entries[0]).toMatchObject({
            type: "custom",
            customType: WorkspaceControlCustomTypes.checkpoint,
            parentId: null,
            data: {
                status: "available",
                turnId: "user-1",
                before: { id: OidA },
                after: { id: OidB },
            },
        });
    });

    it("records expected terminal capture failure as unavailable without rejecting the lifecycle", async () => {
        const fixture = makeFixture();
        fixture.store.capture
            .mockReset()
            .mockResolvedValueOnce({
                ref: snapshot(OidA),
                coverage: { complete: true, eligibleEntryCount: 1, newlyHashedBytes: 1, exclusions: [] },
            })
            .mockRejectedValueOnce(new WorkspaceSnapshotStoreError("capture_timeout", "deadline"));

        await fixture.emit({
            type: "session_before_user_turn",
            boundaryToken: "boundary-1",
            userMessage: { role: "user", content: [] },
        } as AgentHarnessEvent);
        await fixture.emit({
            type: "session_user_turn_committed",
            boundaryToken: "boundary-1",
            userEntryId: "user-1",
        } as AgentHarnessEvent);
        await expect(
            fixture.emit({
                type: "session_user_turn_terminal",
                boundaryToken: "boundary-1",
                reason: "provider_failed",
            } as AgentHarnessEvent)
        ).resolves.toBeUndefined();

        expect(fixture.entries[0]).toMatchObject({
            data: { status: "unavailable", turnId: "user-1", reasonCode: "capture_timeout" },
        });
        expect(fixture.pending.retireUnavailable).toHaveBeenCalledWith("boundary-1");
        expect(fixture.pending.complete).not.toHaveBeenCalled();
    });

    it("retires an uncommitted preparation failure without appending a checkpoint", async () => {
        const fixture = makeFixture();
        await fixture.emit({
            type: "session_before_user_turn",
            boundaryToken: "boundary-1",
            userMessage: { role: "user", content: [] },
        } as AgentHarnessEvent);
        await fixture.emit({
            type: "session_user_turn_terminal",
            boundaryToken: "boundary-1",
            reason: "preparation_failed",
        } as AgentHarnessEvent);

        expect(fixture.session.appendEntries).not.toHaveBeenCalled();
        expect(fixture.pending.retireUnbound).toHaveBeenCalledWith("boundary-1", Owner);
    });

    it("marks a bound turn unavailable while a hosted PTY is active", async () => {
        const fixture = makeFixture();
        await fixture.manager.dispose();
        fixture.store.capture.mockReset().mockResolvedValue({
            ref: snapshot(OidA),
            coverage: { complete: true, eligibleEntryCount: 1, newlyHashedBytes: 1, exclusions: [] },
        });
        const manager = registerWorkspaceCheckpointManager({
            harness: fixture.harness,
            session: fixture.session as never,
            sessionId: "session-1",
            workspaceRoot: "/workspace",
            store: fixture.store as never,
            mutationBarrier: new SessionMutationBarrier(),
            hasRunningHostedCommands: () => true,
            processOwner: Owner,
            onCheckpointCommitted: async () => undefined,
            dependencies: { pendingStore: fixture.pending as never },
        });

        await fixture.emit({
            type: "session_before_user_turn",
            boundaryToken: "boundary-pty",
            userMessage: { role: "user", content: [] },
        } as AgentHarnessEvent);
        await fixture.emit({
            type: "session_user_turn_committed",
            boundaryToken: "boundary-pty",
            userEntryId: "user-pty",
        } as AgentHarnessEvent);
        await fixture.emit({
            type: "session_user_turn_terminal",
            boundaryToken: "boundary-pty",
            reason: "agent_end",
        } as AgentHarnessEvent);

        expect(fixture.entries.at(-1)).toMatchObject({
            data: { status: "unavailable", turnId: "user-pty", reasonCode: "hosted_pty_running" },
        });
        await manager.dispose();
    });

    it("recovers a dead-owner bound pending boundary as unavailable", async () => {
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
    });

    it("dispose waits for manager-owned lifecycle work without waiting on the outer barrier", async () => {
        const fixture = makeFixture();
        let releaseCapture!: () => void;
        const captureGate = new Promise<void>((resolve) => {
            releaseCapture = resolve;
        });
        fixture.store.capture.mockReset().mockImplementationOnce(async () => {
            await captureGate;
            return {
                ref: snapshot(OidA),
                coverage: { complete: true, eligibleEntryCount: 1, newlyHashedBytes: 1, exclusions: [] },
            };
        });
        const lifecycle = fixture.emit({
            type: "session_before_user_turn",
            boundaryToken: "boundary-dispose",
            userMessage: { role: "user", content: [] },
        } as AgentHarnessEvent);
        await vi.waitFor(() => expect(fixture.manager.isBusy()).toBe(true));
        let disposed = false;
        const disposal = fixture.manager.dispose().then(() => {
            disposed = true;
        });

        await Promise.resolve();
        expect(disposed).toBe(false);
        releaseCapture();
        await lifecycle;
        await disposal;
        expect(disposed).toBe(true);
    });
});
