// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { JsonlSessionMetadata, SessionTreeEntry } from "@crest/agent/harness/types";
import type { AgentMessage } from "@crest/agent/types";
import { AgentRuntimeRegistry } from "@crest/coding-agent/agent-runtime-registry";
import type { AgentSessionRuntimeState } from "@crest/coding-agent/agent-session-runtime";
import { describe, expect, it, vi } from "vitest";

import { AgentSessionStateBroadcaster, buildPersistedAgentSessionState } from "./agent-session-state-broadcaster";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function metadata(path: string): JsonlSessionMetadata {
    return {
        id: path.includes("live") ? "live-session" : "cold-session",
        cwd: "/workspace",
        path,
        createdAt: "2026-07-29T00:00:00.000Z",
    };
}

function persistedBranch(): SessionTreeEntry[] {
    return [
        {
            type: "message",
            id: "user-1",
            parentId: null,
            timestamp: "2026-07-29T00:00:00.000Z",
            message: {
                role: "user",
                content: [{ type: "text", text: "hello" }],
                timestamp: 0,
            } as AgentMessage,
        },
        {
            type: "message",
            id: "assistant-1",
            parentId: "user-1",
            timestamp: "2026-07-29T00:00:01.000Z",
            message: {
                role: "assistant",
                content: [{ type: "text", text: "world" }],
                api: "openai-completions",
                provider: "test",
                model: "model",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
                stopReason: "stop",
                timestamp: 1,
            } as AgentMessage,
        },
    ];
}

function fakeSession(branch = persistedBranch()) {
    return {
        buildContext: vi.fn(async () => ({
            messages: branch
                .filter((entry): entry is Extract<SessionTreeEntry, { type: "message" }> => entry.type === "message")
                .map((entry) => entry.message),
        })),
        getBranch: vi.fn(async () => branch),
        getEntries: vi.fn(async () => branch),
        close: vi.fn(),
    };
}

function runtimeState(): AgentSessionRuntimeState {
    const branch = persistedBranch();
    const messages = branch
        .filter((entry): entry is Extract<SessionTreeEntry, { type: "message" }> => entry.type === "message")
        .map((entry) => entry.message);
    return {
        messages,
        turns: [
            {
                turnId: "user-1",
                userMessage: messages[0],
                responseMessages: [messages[1]!],
                status: "done",
            },
        ],
        steerQueue: [],
        followUpQueue: [],
        status: "idle",
        contextReports: [],
        commands: [
            {
                commandId: "completed-command",
                command: "printf done",
                cwd: "/workspace",
                tail: "done",
                screen: {
                    rows: [{ text: "done", cells: [] }],
                    cursor: { row: 0, col: 4, visible: true, shape: "block", blink: false },
                    isAltScreenActive: false,
                },
                running: false,
                exitCode: 0,
                cols: 80,
                rows: 24,
                needsUserInput: false,
            },
        ],
        workspaceRewind: { status: "enabled" },
    };
}

class FakeRuntime {
    readonly state = runtimeState();
    readonly refreshFromPersistedBranch = vi.fn(
        async (options?: { discardCompletedPtyHistory?: boolean; ignoreCompletedOperationId?: string }) => {
            if (options?.discardCompletedPtyHistory) {
                this.state.commands = [];
            }
            return this.state;
        }
    );
    readonly dispose = vi.fn(async () => {});
    readonly listenerIdentity = {};

    isRunning(): boolean {
        return false;
    }
}

describe("AgentSessionStateBroadcaster", () => {
    it("keeps the live runtime and subscription identity while publishing through the owning lease", async () => {
        const registry = new AgentRuntimeRegistry<FakeRuntime>({ idleTtlMs: 1_000 });
        const liveMetadata = metadata("/sessions/live.db");
        const runtime = await registry.getOrCreate(liveMetadata.path, async () => new FakeRuntime());
        registry.acquire(liveMetadata.path, "subscriber-1");
        const publish = vi.fn(async () => {});
        const broadcaster = new AgentSessionStateBroadcaster({
            registry: registry as never,
            openSession: vi.fn(async () => fakeSession() as never),
            publish,
            workspaceRewind: { status: "enabled" },
        });

        const state = await registry.withRetainedSessionMutation(
            liveMetadata.path,
            { rejectIfRunning: true },
            (lease) =>
                broadcaster.publishForLease(lease as never, liveMetadata, {
                    ignoreCompletedOperationId: "operation-1",
                })
        );

        expect(state).toMatchObject({ type: "session_state", status: "idle" });
        expect(runtime.refreshFromPersistedBranch).toHaveBeenCalledWith({
            discardCompletedPtyHistory: true,
            ignoreCompletedOperationId: "operation-1",
        });
        expect(runtime.dispose).not.toHaveBeenCalled();
        expect(registry.get(liveMetadata.path)).toBe(runtime);
        expect(runtime.listenerIdentity).toBe(runtime.listenerIdentity);
        expect(publish).toHaveBeenCalledWith({
            lease: expect.any(Object),
            sessionMetadata: liveMetadata,
            state,
        });
    });

    it("builds byte-for-byte equivalent live and cold authoritative session states", async () => {
        const registry = new AgentRuntimeRegistry<FakeRuntime>({ idleTtlMs: 1_000 });
        const liveMetadata = metadata("/sessions/live.db");
        const coldMetadata = metadata("/sessions/cold.db");
        await registry.getOrCreate(liveMetadata.path, async () => new FakeRuntime());
        const published: unknown[] = [];
        const broadcaster = new AgentSessionStateBroadcaster({
            registry: registry as never,
            openSession: vi.fn(async () => fakeSession() as never),
            publish: vi.fn(async ({ state }) => {
                published.push(state);
            }),
            workspaceRewind: { status: "enabled" },
        });

        await registry.withRetainedSessionMutation(liveMetadata.path, { rejectIfRunning: true }, (lease) =>
            broadcaster.publishForLease(lease as never, liveMetadata)
        );
        await registry.withRetainedSessionMutation(coldMetadata.path, { rejectIfRunning: true }, (lease) =>
            broadcaster.publishForLease(lease as never, coldMetadata)
        );

        expect(published).toHaveLength(2);
        expect(published[0]).toEqual(published[1]);
        expect(published[0]).toEqual(
            await buildPersistedAgentSessionState(fakeSession() as never, { status: "enabled" })
        );
    });

    it("awaits the shared rewind-state builder for cold authoritative publication", async () => {
        const registry = new AgentRuntimeRegistry<FakeRuntime>({ idleTtlMs: 1_000 });
        const coldMetadata = metadata("/sessions/cold-rewind.db");
        const rewindState = {
            enabled: true,
            semanticLeafId: "assistant-1",
            displayLeafId: "assistant-1",
            eligibleTurnIds: ["user-1"],
            turnChanges: [],
            busy: false,
            frozen: true,
            quota: { status: "ok" as const, usedBytes: 1, softQuotaBytes: 2, cleanupAvailable: false },
        };
        const buildRewindState = vi.fn(async () => rewindState);
        const broadcaster = new AgentSessionStateBroadcaster({
            registry: registry as never,
            openSession: vi.fn(async () => fakeSession() as never),
            publish: vi.fn(async () => {}),
            workspaceRewind: { status: "enabled" },
            buildRewindState,
        });

        const state = await registry.withRetainedSessionMutation(
            coldMetadata.path,
            { rejectIfRunning: true },
            (lease) =>
                broadcaster.publishForLease(lease as never, coldMetadata, {
                    ignoreCompletedOperationId: "operation-1",
                })
        );

        expect(buildRewindState).toHaveBeenCalledWith(coldMetadata, persistedBranch(), {
            ignoreCompletedOperationId: "operation-1",
        });
        expect(state.rewindState).toEqual(rewindState);
    });

    it("keeps the cold session open until asynchronous authoritative state construction finishes", async () => {
        const registry = new AgentRuntimeRegistry<FakeRuntime>({ idleTtlMs: 1_000 });
        const coldMetadata = metadata("/sessions/cold-lifecycle.db");
        const branchEntered = deferred();
        const branchGate = deferred();
        const session = fakeSession();
        session.getBranch.mockImplementation(async () => {
            branchEntered.resolve();
            await branchGate.promise;
            return persistedBranch();
        });
        const broadcaster = new AgentSessionStateBroadcaster({
            registry: registry as never,
            openSession: vi.fn(async () => session as never),
            publish: vi.fn(async () => {}),
            workspaceRewind: { status: "enabled" },
        });

        const publication = registry.withRetainedSessionMutation(
            coldMetadata.path,
            { rejectIfRunning: true },
            (lease) => broadcaster.publishForLease(lease as never, coldMetadata)
        );
        await branchEntered.promise;

        expect(session.close).not.toHaveBeenCalled();
        branchGate.resolve();
        await publication;
        expect(session.close).toHaveBeenCalledOnce();
    });

    it("does not release the retained mutation lease until direct publication completes", async () => {
        const registry = new AgentRuntimeRegistry<FakeRuntime>({ idleTtlMs: 1_000 });
        const liveMetadata = metadata("/sessions/live.db");
        await registry.getOrCreate(liveMetadata.path, async () => new FakeRuntime());
        const enteredPublish = deferred();
        const releasePublish = deferred();
        const order: string[] = [];
        const broadcaster = new AgentSessionStateBroadcaster({
            registry: registry as never,
            openSession: vi.fn(async () => fakeSession() as never),
            publish: vi.fn(async () => {
                order.push("broadcast-start");
                enteredPublish.resolve();
                await releasePublish.promise;
                order.push("broadcast-end");
            }),
            workspaceRewind: { status: "enabled" },
        });

        const first = registry.withRetainedSessionMutation(
            liveMetadata.path,
            { rejectIfRunning: true },
            async (lease) => {
                await broadcaster.publishForLease(lease as never, liveMetadata);
                order.push("first-release");
            }
        );
        await enteredPublish.promise;
        const second = registry.withRetainedSessionMutation(liveMetadata.path, { rejectIfRunning: false }, async () => {
            order.push("new-send");
        });
        await Promise.resolve();
        expect(order).toEqual(["broadcast-start"]);

        releasePublish.resolve();
        await Promise.all([first, second]);
        expect(order).toEqual(["broadcast-start", "broadcast-end", "first-release", "new-send"]);
    });
});
