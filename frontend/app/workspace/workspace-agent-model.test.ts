// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAgentModel, type WorkspaceAgentModelEventTarget } from "./workspace-agent-model";
import {
    cloneWorkspaceAgentState,
    hydrateWorkspaceAgentState,
    serializeWorkspaceAgentState,
    workspaceAgentStatesEqual,
} from "./workspace-agent-state";

const SessionOne: AgentSessionMeta = {
    id: "session-1",
    createdAt: "2026-07-25T01:00:00Z",
    cwd: "/tmp/project",
    path: "/tmp/project/.crest/session-1.db",
};
const SessionTwo: AgentSessionMeta = {
    id: "session-2",
    createdAt: "2026-07-25T02:00:00Z",
    cwd: "/tmp/project",
    path: "/tmp/project/.crest/session-2.db",
};
const ModelOne: AgentSelectionMeta = {
    provider: "openai",
    model: "gpt-5",
    reasoning: "high",
};
const ModelTwo: AgentSelectionMeta = {
    provider: "anthropic",
    model: "claude",
    reasoning: "medium",
};

function contextSnapshot(sessionPath: string | undefined, modelKey = "openai/gpt-5"): AgentContextSnapshotView {
    return {
        schemaVersion: 1,
        identity: { sessionPath, leafId: null, modelKey, revision: 1 },
        generatedAt: "2026-08-01T00:00:00Z",
        lifecycle: "ready",
        accuracy: "estimated",
        modelLabel: modelKey,
        contextWindow: 100_000,
        outputReserve: 10_000,
        inputCapacity: 90_000,
        effectiveInputTokens: 12,
        remainingInputTokens: 89_988,
        categories: [],
        items: [],
    };
}

class FakeEventTarget implements WorkspaceAgentModelEventTarget {
    visibilityState = "visible";
    listeners = new Map<string, Set<() => void>>();

    addEventListener(type: string, listener: () => void): void {
        const listeners = this.listeners.get(type) ?? new Set();
        listeners.add(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: () => void): void {
        this.listeners.get(type)?.delete(listener);
    }

    dispatch(type: string): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener();
        }
    }

    listenerCount(): number {
        return Array.from(this.listeners.values()).reduce((count, listeners) => count + listeners.size, 0);
    }
}

function checkpoint(revision: number, state: WorkspaceAgentCheckpoint["state"] = {}): WorkspaceAgentCheckpoint {
    return {
        workspaceid: "ws-1",
        revision,
        state,
    };
}

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

afterEach(async () => {
    await WorkspaceAgentModel.resetInstances();
    vi.useRealTimers();
});

describe("workspace Agent state helpers", () => {
    it("hydrates, clones, and serializes without retaining descriptor references", () => {
        const persisted: WorkspaceAgentState = {
            activesession: { ...SessionOne },
            selection: { ...ModelOne },
        };

        const hydrated = hydrateWorkspaceAgentState(persisted);
        const cloned = cloneWorkspaceAgentState(hydrated);
        const serialized = serializeWorkspaceAgentState(hydrated);
        persisted.activesession.id = "mutated";
        persisted.selection.model = "mutated";
        hydrated.activeSession.id = "local-mutated";

        expect(cloned).toEqual({
            activeSession: SessionOne,
            selection: ModelOne,
        });
        expect(serialized).toEqual({
            activesession: SessionOne,
            selection: ModelOne,
        });
        expect(workspaceAgentStatesEqual(cloned, hydrateWorkspaceAgentState(serialized))).toBe(true);
    });
});

describe("WorkspaceAgentModel", () => {
    it("keeps context inspection transient and rejects stale session or model results", () => {
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 4,
            initialState: { activesession: SessionOne },
        });
        const first = model.beginContextInspection({
            workspaceGeneration: 4,
            sessionGeneration: 0,
            sessionPath: SessionOne.path,
            modelKey: "openai/gpt-5",
        });
        const second = model.beginContextInspection({
            workspaceGeneration: 4,
            sessionGeneration: 1,
            sessionPath: SessionTwo.path,
            modelKey: "anthropic/claude",
        });

        expect(model.publishContextSnapshot(first, contextSnapshot(SessionOne.path))).toBe(false);
        expect(model.publishContextSnapshot(second, contextSnapshot(SessionTwo.path))).toBe(false);
        expect(model.publishContextSnapshot(second, contextSnapshot(SessionTwo.path, "anthropic/claude"))).toBe(true);
        expect(globalStore.get(model.contextSnapshotAtom)).toMatchObject({
            status: "ready",
            identity: second,
            snapshot: { identity: { sessionPath: SessionTwo.path, modelKey: "anthropic/claude" } },
        });
        expect(serializeWorkspaceAgentState(globalStore.get(model.stateAtom))).toEqual({
            activesession: SessionOne,
        });
    });

    it("keeps same-identity inventory out of date after refresh failure and rejects older leaves", () => {
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 4,
        });
        const identity = model.beginContextInspection({
            workspaceGeneration: 4,
            sessionGeneration: 0,
            sessionPath: SessionOne.path,
            modelKey: "openai/gpt-5",
        });
        const current = contextSnapshot(SessionOne.path);
        current.identity.leafId = "leaf-new";
        current.identity.revision = 3;
        expect(model.publishContextSnapshot(identity, current)).toBe(true);

        model.beginContextInspection(identity);
        expect(model.failContextInspection(identity, "refresh failed")).toBe(true);
        expect(globalStore.get(model.contextSnapshotAtom)).toMatchObject({
            status: "out_of_date",
            errorMessage: "refresh failed",
            snapshot: { identity: { leafId: "leaf-new", revision: 3 } },
        });

        const stale = contextSnapshot(SessionOne.path);
        stale.identity.leafId = "leaf-old";
        stale.identity.revision = 2;
        expect(model.publishContextSnapshot(identity, stale)).toBe(false);
    });

    it("owns one model per exact window, workspace, and generation identity", async () => {
        const first = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 2,
        });

        expect(
            WorkspaceAgentModel.getInstance({
                windowId: "win-1",
                workspaceId: "ws-1",
                generation: 2,
            })
        ).toBe(first);
        expect(() =>
            WorkspaceAgentModel.getInstance({
                windowId: "win-1",
                workspaceId: "ws-1",
                generation: 3,
            })
        ).toThrow(/already owns/i);

        await first.dispose();
    });

    it("updates session and model selection locally before its 300ms debounced save", async () => {
        vi.useFakeTimers();
        const saveCheckpoint = vi
            .fn()
            .mockResolvedValue(checkpoint(1, { activesession: SessionOne, selection: ModelOne }));
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 1,
            saveCheckpoint,
        });

        model.selectSession(SessionOne);
        model.selectModel(ModelOne);

        expect(globalStore.get(model.stateAtom)).toEqual({
            activeSession: SessionOne,
            selection: ModelOne,
        });
        expect(globalStore.get(model.statusAtom)).toBe("dirty");
        expect(saveCheckpoint).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(299);
        expect(saveCheckpoint).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(saveCheckpoint).toHaveBeenCalledTimes(1);
        await model.flush();
        expect(globalStore.get(model.statusAtom)).toBe("clean");
    });

    it("advances one authoritative session generation for every local session intent and external replacement", () => {
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 1,
            initialState: { activesession: SessionOne },
            initialRevision: 1,
        });

        expect(globalStore.get(model.sessionGenerationAtom)).toBe(0);
        model.selectSession(SessionTwo);
        expect(globalStore.get(model.sessionGenerationAtom)).toBe(1);
        model.selectSession(SessionOne);
        expect(globalStore.get(model.sessionGenerationAtom)).toBe(2);
        model.selectSession(SessionOne);
        expect(globalStore.get(model.sessionGenerationAtom)).toBe(3);

        expect(model.reconcile(checkpoint(2, { activesession: SessionTwo }), 1)).toBe(true);
        expect(globalStore.get(model.sessionGenerationAtom)).toBe(3);

        const externallyReconciled = WorkspaceAgentModel.getInstance({
            windowId: "win-2",
            workspaceId: "ws-1",
            generation: 1,
            initialState: { activesession: SessionOne },
            initialRevision: 1,
        });
        expect(externallyReconciled.reconcile(checkpoint(2, { activesession: SessionTwo }), 1)).toBe(true);
        expect(globalStore.get(externallyReconciled.sessionGenerationAtom)).toBe(1);
    });

    it("saves the exact workspace identity and independent expected revision", async () => {
        const saveCheckpoint = vi.fn().mockResolvedValue(checkpoint(8, { selection: ModelOne }));
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 4,
            initialRevision: 7,
            saveCheckpoint,
        });

        model.selectModel(ModelOne);
        await model.flush();

        expect(saveCheckpoint).toHaveBeenCalledWith({
            workspaceid: "ws-1",
            expectedrevision: 7,
            state: {
                selection: ModelOne,
            },
        });
        expect(model.revision).toBe(8);
        expect(globalStore.get(model.statusAtom)).toBe("clean");
    });

    it("serializes saves and drains a newer local intent after the first completes", async () => {
        const first = deferred<WorkspaceAgentCheckpoint>();
        const saveCheckpoint = vi
            .fn()
            .mockImplementationOnce(() => first.promise)
            .mockResolvedValueOnce(checkpoint(2, { activesession: SessionOne, selection: ModelTwo }));
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 1,
            saveCheckpoint,
        });

        model.selectModel(ModelOne);
        const firstFlush = model.flush();
        model.selectModel(ModelTwo);
        model.selectSession(SessionOne);
        const secondFlush = model.flush();

        expect(saveCheckpoint).toHaveBeenCalledTimes(1);
        first.resolve(checkpoint(1, { selection: ModelOne }));
        await Promise.all([firstFlush, secondFlush]);

        expect(saveCheckpoint).toHaveBeenCalledTimes(2);
        expect(saveCheckpoint.mock.calls[1][0]).toEqual({
            workspaceid: "ws-1",
            expectedrevision: 1,
            state: {
                activesession: SessionOne,
                selection: ModelTwo,
            },
        });
    });

    it("preserves and drains B when WOS echoes saved A before A's response", async () => {
        const first = deferred<WorkspaceAgentCheckpoint>();
        const saveCheckpoint = vi
            .fn()
            .mockImplementationOnce(() => first.promise)
            .mockResolvedValueOnce(checkpoint(2, { selection: ModelTwo }));
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 3,
            saveCheckpoint,
        });

        model.selectModel(ModelOne);
        const flushing = model.flush();
        model.selectModel(ModelTwo);
        expect(model.reconcile(checkpoint(1, { selection: ModelOne }), 3)).toBe(true);

        expect(globalStore.get(model.stateAtom).selection).toEqual(ModelTwo);
        expect(globalStore.get(model.statusAtom)).toBe("dirty");
        first.resolve(checkpoint(1, { selection: ModelOne }));
        await flushing;

        expect(saveCheckpoint).toHaveBeenCalledTimes(2);
        expect(saveCheckpoint.mock.calls[1][0]).toEqual({
            workspaceid: "ws-1",
            expectedrevision: 1,
            state: {
                selection: ModelTwo,
            },
        });
        expect(model.revision).toBe(2);
        expect(globalStore.get(model.stateAtom).selection).toEqual(ModelTwo);
        expect(globalStore.get(model.statusAtom)).toBe("clean");
    });

    it("treats a matching WOS echo as confirmation without saving A twice", async () => {
        const first = deferred<WorkspaceAgentCheckpoint>();
        const saveCheckpoint = vi
            .fn()
            .mockImplementationOnce(() => first.promise)
            .mockResolvedValueOnce(checkpoint(2, { selection: ModelOne }));
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 3,
            saveCheckpoint,
        });

        model.selectModel(ModelOne);
        const flushing = model.flush();
        expect(model.reconcile(checkpoint(1, { selection: ModelOne }), 3)).toBe(true);

        expect(globalStore.get(model.stateAtom).selection).toEqual(ModelOne);
        expect(globalStore.get(model.statusAtom)).toBe("clean");
        first.resolve(checkpoint(1, { selection: ModelOne }));
        await flushing;

        expect(saveCheckpoint).toHaveBeenCalledTimes(1);
        expect(model.revision).toBe(1);
        expect(globalStore.get(model.statusAtom)).toBe("clean");
    });

    it("reloads after stale and retries the still-current field intent once over authoritative state", async () => {
        const saveCheckpoint = vi
            .fn()
            .mockRejectedValueOnce(new Error("stale workspace checkpoint: expected Agent revision 2"))
            .mockResolvedValueOnce(
                checkpoint(6, {
                    activesession: SessionTwo,
                    selection: ModelOne,
                })
            );
        const reloadCheckpoint = vi.fn().mockResolvedValue(
            checkpoint(5, {
                activesession: SessionTwo,
                selection: ModelTwo,
            })
        );
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 1,
            initialRevision: 2,
            initialState: {
                activesession: SessionOne,
                selection: ModelTwo,
            },
            saveCheckpoint,
            reloadCheckpoint,
        });

        model.selectModel(ModelOne);
        await model.flush();

        expect(reloadCheckpoint).toHaveBeenCalledTimes(1);
        expect(saveCheckpoint).toHaveBeenCalledTimes(2);
        expect(saveCheckpoint.mock.calls[1][0]).toEqual({
            workspaceid: "ws-1",
            expectedrevision: 5,
            state: {
                activesession: SessionTwo,
                selection: ModelOne,
            },
        });
        expect(globalStore.get(model.stateAtom)).toEqual({
            activeSession: SessionTwo,
            selection: ModelOne,
        });
    });

    it("accepts strict checkpoints and rejects stale, equal-different, wrong-workspace, and wrong-generation data", () => {
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 7,
            initialRevision: 3,
            initialState: { selection: ModelOne },
        });

        expect(model.reconcile(checkpoint(2, { selection: ModelTwo }), 7)).toBe(false);
        expect(model.reconcile(checkpoint(3, { selection: ModelTwo }), 7)).toBe(false);
        expect(model.reconcile({ ...checkpoint(4), workspaceid: "ws-2" }, 7)).toBe(false);
        expect(model.reconcile(checkpoint(4), 6)).toBe(false);
        expect(model.reconcile(checkpoint(3, { selection: ModelOne }), 7)).toBe(true);
        expect(model.reconcile(checkpoint(4, { selection: ModelTwo }), 7)).toBe(true);
        expect(globalStore.get(model.stateAtom).selection).toEqual(ModelTwo);
    });

    it("finishes the active save before completing disposal and blocks new updates", async () => {
        const windowTarget = new FakeEventTarget();
        const documentTarget = new FakeEventTarget();
        const pending = deferred<WorkspaceAgentCheckpoint>();
        const saveCheckpoint = vi.fn(() => pending.promise);
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 1,
            saveCheckpoint,
            windowTarget,
            documentTarget,
        });
        model.selectSession(SessionOne);
        const flushing = model.flush();

        const disposing = model.dispose();
        model.selectSession(SessionTwo);
        expect(globalStore.get(model.stateAtom).activeSession).toEqual(SessionOne);
        expect(WorkspaceAgentModel.instances.get("win-1")).toBe(model);
        pending.resolve(checkpoint(1, { activesession: SessionOne }));
        await Promise.all([flushing, disposing]);

        expect(globalStore.get(model.stateAtom).activeSession).toEqual(SessionOne);
        expect(model.revision).toBe(1);
        expect(globalStore.get(model.statusAtom)).toBe("clean");
        expect(model.reconcile(checkpoint(2, { activesession: SessionTwo }), 1)).toBe(false);
        expect(WorkspaceAgentModel.instances.get("win-1")).toBeUndefined();
        expect(windowTarget.listenerCount()).toBe(0);
        expect(documentTarget.listenerCount()).toBe(0);
    });

    it("keeps resetting instances registered until their disposal flushes finish", async () => {
        const pending = deferred<WorkspaceAgentCheckpoint>();
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 1,
            saveCheckpoint: vi.fn(() => pending.promise),
        });
        model.selectSession(SessionOne);

        const resetting = WorkspaceAgentModel.resetInstances();

        expect(WorkspaceAgentModel.instances.get("win-1")).toBe(model);
        pending.resolve(checkpoint(1, { activesession: SessionOne }));
        await resetting;
        expect(WorkspaceAgentModel.instances.get("win-1")).toBeUndefined();
    });

    it("reloads and retries a stale CAS before completing disposal", async () => {
        const reload = deferred<WorkspaceAgentCheckpoint>();
        const saveCheckpoint = vi
            .fn()
            .mockRejectedValueOnce(new Error("stale workspace checkpoint"))
            .mockResolvedValueOnce(checkpoint(10, { activesession: SessionTwo, selection: ModelOne }));
        const reloadCheckpoint = vi.fn(() => reload.promise);
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 1,
            initialRevision: 4,
            initialState: { activesession: SessionOne },
            saveCheckpoint,
            reloadCheckpoint,
        });
        model.selectModel(ModelOne);
        const flushing = model.flush();
        await vi.waitFor(() => expect(reloadCheckpoint).toHaveBeenCalledTimes(1));

        const disposing = model.dispose();
        reload.resolve(checkpoint(9, { activesession: SessionTwo, selection: ModelTwo }));
        await Promise.all([flushing, disposing]);

        expect(model.revision).toBe(10);
        expect(globalStore.get(model.stateAtom)).toEqual({
            activeSession: SessionTwo,
            selection: ModelOne,
        });
        expect(saveCheckpoint).toHaveBeenCalledTimes(2);
        expect(saveCheckpoint.mock.calls[1][0]).toEqual({
            workspaceid: "ws-1",
            expectedrevision: 9,
            state: {
                activesession: SessionTwo,
                selection: ModelOne,
            },
        });
    });

    it("flushes on blur, hidden visibility, and beforeunload", async () => {
        const windowTarget = new FakeEventTarget();
        const documentTarget = new FakeEventTarget();
        const saveCheckpoint = vi
            .fn()
            .mockResolvedValueOnce(checkpoint(1, { selection: ModelOne }))
            .mockResolvedValueOnce(checkpoint(2, { selection: ModelTwo }))
            .mockResolvedValueOnce(checkpoint(3, {}));
        const model = WorkspaceAgentModel.getInstance({
            windowId: "win-1",
            workspaceId: "ws-1",
            generation: 1,
            saveCheckpoint,
            windowTarget,
            documentTarget,
        });

        model.selectModel(ModelOne);
        windowTarget.dispatch("blur");
        await vi.waitFor(() => expect(saveCheckpoint).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(globalStore.get(model.statusAtom)).toBe("clean"));
        model.selectModel(ModelTwo);
        documentTarget.visibilityState = "hidden";
        documentTarget.dispatch("visibilitychange");
        await vi.waitFor(() => expect(saveCheckpoint).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(globalStore.get(model.statusAtom)).toBe("clean"));
        model.selectModel(undefined);
        windowTarget.dispatch("beforeunload");
        await vi.waitFor(() => expect(saveCheckpoint).toHaveBeenCalledTimes(3));
    });
});
