// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, vi } from "vitest";

import { AnchoredReaderError } from "./anchored-reader";
import type { IncrementalPathCaptureResult } from "./incremental-path-capture";
import { WorkspaceCheckpointLimits, WorkspaceSnapshotStoreError } from "./snapshot-store";
import type { WorkspaceSnapshotCoverage, WorkspaceSnapshotRefV1 } from "./types";
import type { WorkspaceChangeDrain, WorkspaceChangeFeed } from "./workspace-change-feed";
import {
    WorkspaceSnapshotTracker,
    type WorkspaceSnapshotTrackerPathCapture,
    type WorkspaceSnapshotTrackerStateAccess,
    type WorkspaceSnapshotTrackerStore,
} from "./workspace-snapshot-tracker";

const WorkspaceIdentity = "a".repeat(64);
const WorkspaceIncarnation = "b".repeat(64);
const Ref1 = snapshot("1");
const Ref2 = snapshot("2");
const Ref3 = snapshot("3");
const Coverage: WorkspaceSnapshotCoverage = {
    complete: true,
    eligibleEntryCount: 1,
    newlyHashedBytes: 4,
    exclusions: [],
};
const Metadata = {
    scope: {
        schemaVersion: 1 as const,
        policy: {
            maxEntries: 200_000,
            maxUntrackedBytes: 2 * 1024 ** 2,
            gitGlobalExcludes: "disabled-by-isolated-runner" as const,
        },
        ignoreInputs: [],
        nestedRepositoryBoundaries: [],
    },
    coverage: { complete: true, eligibleEntryCount: 1, exclusions: [] },
};

describe("WorkspaceSnapshotTracker", () => {
    test("cold starts with one ordered reconcile and keeps warm empty capture off every full hot path", async () => {
        const fixture = makeFixture();
        fixture.feed.drain.mockResolvedValue(complete([]));

        await expect(fixture.tracker.capture({ profile: "pre-turn" })).resolves.toEqual({
            ref: Ref1,
            coverage: Coverage,
        });
        await expect(fixture.tracker.capture({ profile: "terminal" })).resolves.toEqual({
            ref: Ref1,
            coverage: { ...Coverage, newlyHashedBytes: 0 },
        });

        expect(fixture.order).toEqual([
            "state:load",
            "feed:start",
            "store:full:pre-turn",
            "store:metadata:1",
            "state:publish:1",
            "state:publish:1",
        ]);
        expect(fixture.store.captureFullReconcile).toHaveBeenCalledTimes(1);
        expect(fixture.store.readIncrementalSnapshotMetadata).toHaveBeenCalledTimes(1);
        expect(fixture.makePathCapture).toHaveBeenCalledTimes(1);
        expect(fixture.pathCapture.capture).not.toHaveBeenCalled();
    });

    test("validates durable current after reconstruction but never trusts a v1 feed baseline across startup", async () => {
        const state = makeStateAccess({ status: "trusted", current: Ref1, coverage: Metadata.coverage });
        const fixture = makeFixture({ state });

        await fixture.tracker.capture({ profile: "pre-turn" });

        expect(state.load).toHaveBeenCalledTimes(1);
        expect(fixture.order.slice(0, 3)).toEqual(["feed:start", "store:full:pre-turn", "store:metadata:1"]);
        expect(fixture.store.captureFullReconcile).toHaveBeenCalledTimes(1);
    });

    test("forces the full reconcile lifecycle for warm captures with required paths", async () => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        fixture.order.length = 0;
        fixture.store.captureFullReconcile.mockResolvedValueOnce({ ref: Ref2, coverage: Coverage });

        await expect(
            fixture.tracker.capture({
                profile: "terminal",
                requiredPaths: ["oversized.bin", "ignored/required.txt"],
            })
        ).resolves.toEqual({ ref: Ref2, coverage: Coverage });

        expect(fixture.store.captureFullReconcile).toHaveBeenLastCalledWith({
            profile: "terminal",
            requiredPaths: ["oversized.bin", "ignored/required.txt"],
        });
        expect(fixture.feed.drain).not.toHaveBeenCalled();
        expect(fixture.pathCapture.capture).not.toHaveBeenCalled();
        expect(fixture.order.slice(0, 3)).toEqual(["feed:start", "store:metadata:2", "state:publish:2"]);
        expectReconcileOrder(fixture);
    });

    test.each([
        ["pre-turn", WorkspaceCheckpointLimits.preTurnTimeoutMs],
        ["terminal", WorkspaceCheckpointLimits.terminalTimeoutMs],
        ["safety", WorkspaceCheckpointLimits.terminalTimeoutMs],
    ] as const)("forwards the fixed %s incremental timeout", async (profile, timeoutMs) => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        fixture.feed.drain.mockResolvedValueOnce(complete(["a.txt"]));
        fixture.feed.drain.mockResolvedValueOnce(complete([]));

        await fixture.tracker.capture({ profile });

        expect(fixture.pathCapture.capture).toHaveBeenCalledWith(["a.txt"], undefined, timeoutMs);
    });

    test("maps an internal incremental deadline to a typed capture-timeout failure", async () => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        fixture.feed.drain.mockResolvedValueOnce(complete(["a.txt"]));
        const cause = new AnchoredReaderError("timeout", "Incremental path capture timed out");
        fixture.pathCapture.capture.mockRejectedValueOnce(cause);

        const failure = await fixture.tracker.capture({ profile: "terminal" }).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(WorkspaceSnapshotStoreError);
        expect(failure).toMatchObject({ code: "capture_timeout", cause });
    });

    test("maps an internal timeout that wins before a later caller abort is observed", async () => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        fixture.feed.drain.mockResolvedValueOnce(complete(["a.txt"]));
        const controller = new AbortController();
        const internalTimeout = new AnchoredReaderError("timeout", "Incremental path capture timed out");
        const callerReason = new Error("caller aborted after the internal deadline");
        fixture.pathCapture.capture.mockImplementationOnce(() => {
            const rejected = Promise.reject(internalTimeout);
            controller.abort(callerReason);
            return rejected;
        });

        const failure = await fixture.tracker
            .capture({ profile: "terminal", signal: controller.signal })
            .catch((error: unknown) => error);

        expect(controller.signal.reason).toBe(callerReason);
        expect(failure).toBeInstanceOf(WorkspaceSnapshotStoreError);
        expect(failure).toMatchObject({ code: "capture_timeout", cause: internalTimeout });
    });

    test("preserves a caller-driven abort reason from incremental capture", async () => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        fixture.feed.drain.mockResolvedValueOnce(complete(["a.txt"]));
        const controller = new AbortController();
        const reason = new AnchoredReaderError("timeout", "caller-owned deadline");
        fixture.pathCapture.capture.mockImplementationOnce(async () => {
            controller.abort(reason);
            throw reason;
        });

        await expect(fixture.tracker.capture({ profile: "terminal", signal: controller.signal })).rejects.toBe(reason);
    });

    test("preserves an anchored-reader aborted failure from incremental capture", async () => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        fixture.feed.drain.mockResolvedValueOnce(complete(["a.txt"]));
        const error = new AnchoredReaderError("aborted", "Incremental path capture aborted");
        fixture.pathCapture.capture.mockRejectedValueOnce(error);

        await expect(fixture.tracker.capture({ profile: "terminal" })).rejects.toBe(error);
    });

    test("rejects a pre-aborted warm empty capture without publishing state", async () => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        fixture.feed.drain.mockClear();
        fixture.state.publish.mockClear();
        const controller = new AbortController();
        const reason = new Error("capture cancelled");
        controller.abort(reason);

        await expect(fixture.tracker.capture({ profile: "terminal", signal: controller.signal })).rejects.toBe(reason);

        expect(fixture.feed.drain).not.toHaveBeenCalled();
        expect(fixture.state.publish).not.toHaveBeenCalled();
    });

    test("does not publish a queued capture whose signal aborts before it starts", async () => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        fixture.feed.drain.mockClear();
        fixture.state.publish.mockClear();
        const firstRead = deferred<WorkspaceChangeDrain>();
        fixture.feed.drain.mockReturnValueOnce(firstRead.promise).mockResolvedValueOnce(complete([]));
        const first = fixture.tracker.capture({ profile: "terminal" });
        await vi.waitFor(() => expect(fixture.feed.drain).toHaveBeenCalledTimes(1));
        const controller = new AbortController();
        const reason = new Error("queued capture cancelled");
        const second = fixture.tracker.capture({ profile: "terminal", signal: controller.signal });
        controller.abort(reason);
        firstRead.resolve(complete([]));

        await first;
        await expect(second).rejects.toBe(reason);
        expect(fixture.feed.drain).toHaveBeenCalledTimes(1);
        expect(fixture.state.publish).toHaveBeenCalledTimes(1);
    });

    test("recaptures a same-path interval mutation and commits only bytes covered by the stable candidate", async () => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        fixture.order.length = 0;
        fixture.feed.drain.mockResolvedValueOnce(complete(["a.txt"]));
        fixture.feed.drain.mockResolvedValueOnce(complete(["a.txt"])).mockResolvedValueOnce(complete([]));
        fixture.pathCapture.capture
            .mockResolvedValueOnce(capturedFile("a.txt", "1"))
            .mockResolvedValueOnce(capturedFile("a.txt", "2"));
        fixture.store.computeIncrementalSnapshotCoverage.mockResolvedValue(Metadata.coverage);
        fixture.store.commitCapturedIncrementalSnapshot.mockImplementation(async (input) => {
            fixture.order.push("store:incremental");
            expect(input.mutations).toEqual([
                {
                    path: "a.txt",
                    state: { state: "file", oid: "2".repeat(40), executable: false },
                },
            ]);
            return { ref: Ref2, coverage: { ...Coverage, newlyHashedBytes: 2 } };
        });

        await expect(fixture.tracker.capture({ profile: "terminal" })).resolves.toEqual({
            ref: Ref2,
            coverage: { ...Coverage, newlyHashedBytes: 2 },
        });

        expect(fixture.pathCapture.capture).toHaveBeenNthCalledWith(1, ["a.txt"], undefined, 30_000);
        expect(fixture.pathCapture.capture).toHaveBeenNthCalledWith(2, ["a.txt"], undefined, 30_000);
        expect(fixture.feed.drain).toHaveBeenNthCalledWith(2);
        expect(fixture.feed.drain).toHaveBeenNthCalledWith(3);
        expect(fixture.pathCapture.discardCaptured).toHaveBeenCalledTimes(1);
        expect(fixture.pathCapture.consumeCaptured).toHaveBeenCalledTimes(1);
        expect(fixture.order).toEqual(["path:discard", "path:consume", "store:incremental", "state:publish:2"]);
        expect(fixture.store.captureFullReconcile).toHaveBeenCalledTimes(1);
    });

    test("falls back to full reconcile when the same path changes again after the single retry", async () => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        fixture.order.length = 0;
        fixture.feed.drain.mockResolvedValueOnce(complete(["a.txt"]));
        fixture.feed.drain.mockResolvedValueOnce(complete(["a.txt"])).mockResolvedValueOnce(complete(["a.txt"]));
        fixture.pathCapture.capture.mockResolvedValueOnce(captured("a.txt")).mockResolvedValueOnce(captured("a.txt"));
        fixture.store.captureFullReconcile.mockResolvedValueOnce({ ref: Ref3, coverage: Coverage });

        await expect(fixture.tracker.capture({ profile: "terminal" })).resolves.toEqual({
            ref: Ref3,
            coverage: Coverage,
        });

        expect(fixture.pathCapture.discardCaptured).toHaveBeenCalledTimes(2);
        expect(fixture.store.commitCapturedIncrementalSnapshot).not.toHaveBeenCalled();
        expect(fixture.order.slice(-3)).toEqual(["feed:start", "store:metadata:3", "state:publish:3"]);
        expectReconcileOrder(fixture);
    });

    test.each([
        ["feed gap", { reads: [{ status: "unavailable", reason: "watcher-error" } as WorkspaceChangeDrain] }],
        ["scope-affecting path", { reads: [complete(["nested/.gitignore"])] }],
        [
            "path instability",
            { reads: [complete(["a.txt"])], capture: { status: "reconcile", reason: "unstable-path" } },
        ],
        [
            "unsafe path evidence",
            { reads: [complete(["a.txt"])], capture: { status: "reconcile", reason: "unsafe-evidence" } },
        ],
    ])("uses start -> full reconcile for %s", async (_name, scenario) => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        fixture.order.length = 0;
        fixture.feed.drain.mockResolvedValueOnce(scenario.reads[0]!);
        if ("capture" in scenario) fixture.pathCapture.capture.mockResolvedValueOnce(scenario.capture as never);
        fixture.store.captureFullReconcile.mockResolvedValueOnce({ ref: Ref2, coverage: Coverage });

        await fixture.tracker.capture({ profile: "terminal" });

        expect(fixture.order.slice(-3)).toEqual(["feed:start", "store:metadata:2", "state:publish:2"]);
        expectReconcileOrder(fixture);
    });

    test("discards captured bytes and fully reconciles after a validation gap", async () => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        fixture.feed.drain.mockResolvedValueOnce(complete(["a.txt"]));
        fixture.feed.drain.mockResolvedValueOnce({ status: "unavailable", reason: "watcher-error" });
        fixture.store.captureFullReconcile.mockResolvedValueOnce({ ref: Ref2, coverage: Coverage });

        await expect(fixture.tracker.capture({ profile: "terminal" })).resolves.toEqual({
            ref: Ref2,
            coverage: Coverage,
        });

        expect(fixture.pathCapture.discardCaptured).toHaveBeenCalledTimes(1);
        expect(fixture.store.commitCapturedIncrementalSnapshot).not.toHaveBeenCalled();
        expectReconcileOrder(fixture);
    });

    test("does not initialize or publish current when full reconcile fails and preserves the typed store error", async () => {
        const fixture = makeFixture();
        const error = new WorkspaceSnapshotStoreError("unstable_file", "Workspace did not settle");
        fixture.store.captureFullReconcile.mockRejectedValueOnce(error);

        await expect(fixture.tracker.capture({ profile: "terminal" })).rejects.toBe(error);

        expect(fixture.feed.start).toHaveBeenCalledTimes(1);
        expect(fixture.state.publish).not.toHaveBeenCalled();

        await fixture.tracker.capture({ profile: "terminal" });
        expect(fixture.store.captureFullReconcile).toHaveBeenCalledTimes(2);
    });

    test("retains an old path capture when full-reconcile replacement disposal fails", async () => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        const oldCapture = fixture.pathCapture;
        const nextCapture = makePathCapture();
        fixture.makePathCapture.mockReturnValueOnce(nextCapture);
        oldCapture.dispose.mockRejectedValueOnce(new Error("old dispose failed"));
        fixture.feed.drain.mockResolvedValueOnce({ status: "unavailable", reason: "watcher-error" });

        await expect(fixture.tracker.capture({ profile: "terminal" })).rejects.toThrow("old dispose failed");

        expect(fixture.tracker.pathCapture).toBe(oldCapture);
        expect(nextCapture.dispose).toHaveBeenCalledTimes(1);
        await expect(fixture.tracker.dispose()).resolves.toBeUndefined();
        expect(oldCapture.dispose).toHaveBeenCalledTimes(2);
    });

    test("aggregates replacement cleanup failures and retains both captures for later disposal", async () => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        const oldCapture = fixture.pathCapture;
        const nextCapture = makePathCapture();
        fixture.makePathCapture.mockReturnValueOnce(nextCapture);
        oldCapture.dispose.mockRejectedValueOnce(new Error("old dispose failed"));
        nextCapture.dispose.mockRejectedValueOnce(new Error("new dispose failed"));
        fixture.feed.drain.mockResolvedValueOnce({ status: "unavailable", reason: "watcher-error" });

        await expect(fixture.tracker.capture({ profile: "terminal" })).rejects.toBeInstanceOf(AggregateError);
        expect(fixture.tracker.pathCapture).toBe(oldCapture);
        await expect(fixture.tracker.dispose()).resolves.toBeUndefined();
        expect(oldCapture.dispose).toHaveBeenCalledTimes(2);
        expect(nextCapture.dispose).toHaveBeenCalledTimes(2);
    });

    test("retains untrusted state after start failure and repeats a full reconcile", async () => {
        const fixture = makeFixture();
        fixture.feed.start.mockRejectedValueOnce(new Error("start failed"));

        await expect(fixture.tracker.capture({ profile: "pre-turn" })).rejects.toThrow("start failed");
        expect(fixture.store.captureFullReconcile).not.toHaveBeenCalled();
        expect(fixture.state.publish).not.toHaveBeenCalled();

        await fixture.tracker.capture({ profile: "terminal" });
        expect(fixture.store.captureFullReconcile).toHaveBeenCalledTimes(1);
        expect(fixture.state.publish).toHaveBeenCalledTimes(1);
    });

    test("rejects a full reconcile if the watcher loses trust during capture", async () => {
        const fixture = makeFixture();
        fixture.feed.isTrusted.mockReturnValueOnce(false);

        await expect(fixture.tracker.capture({ profile: "pre-turn" })).rejects.toThrow(/lost trust/i);
        expect(fixture.state.publish).not.toHaveBeenCalled();

        await fixture.tracker.capture({ profile: "terminal" });
        expect(fixture.store.captureFullReconcile).toHaveBeenCalledTimes(2);
    });

    test.each(["snapshot", "state"] as const)(
        "fails closed at the %s publication boundary and reconciles before the next capture",
        async (boundary) => {
            const hooks = {
                afterIncrementalSnapshotPublished:
                    boundary === "snapshot"
                        ? vi.fn(() => {
                              throw new Error("crash");
                          })
                        : undefined,
                afterTrackerStatePublished:
                    boundary === "state"
                        ? vi.fn(() => {
                              throw new Error("crash");
                          })
                        : undefined,
            };
            const fixture = makeFixture({ hooks });
            await fixture.tracker.capture({ profile: "pre-turn" });
            fixture.feed.drain.mockResolvedValueOnce(complete(["a.txt"]));
            fixture.feed.drain.mockResolvedValueOnce(complete([]));
            fixture.pathCapture.capture.mockResolvedValueOnce(captured("a.txt"));
            fixture.store.computeIncrementalSnapshotCoverage.mockResolvedValue(Metadata.coverage);
            fixture.store.commitCapturedIncrementalSnapshot.mockResolvedValue({
                ref: Ref2,
                coverage: { ...Coverage, newlyHashedBytes: 1 },
            });

            await expect(fixture.tracker.capture({ profile: "terminal" })).rejects.toThrow("crash");
            if (boundary === "state") expect(fixture.state.publish).toHaveBeenCalledTimes(2);

            fixture.store.captureFullReconcile.mockResolvedValueOnce({ ref: Ref3, coverage: Coverage });
            await fixture.tracker.capture({ profile: "terminal" });
            expect(fixture.store.captureFullReconcile).toHaveBeenCalledTimes(2);
        }
    );

    test("serializes tracker captures without requiring an outer Agent-turn lock", async () => {
        const full = deferred<{ ref: WorkspaceSnapshotRefV1; coverage: WorkspaceSnapshotCoverage }>();
        const fixture = makeFixture();
        fixture.store.captureFullReconcile.mockReturnValueOnce(full.promise);

        const first = fixture.tracker.capture({ profile: "pre-turn" });
        const second = fixture.tracker.capture({ profile: "terminal" });
        await vi.waitFor(() => expect(fixture.store.captureFullReconcile).toHaveBeenCalledTimes(1));
        expect(fixture.feed.drain).not.toHaveBeenCalled();
        full.resolve({ ref: Ref1, coverage: Coverage });
        await first;
        fixture.feed.drain.mockResolvedValueOnce(complete([]));
        await second;

        expect(fixture.store.captureFullReconcile).toHaveBeenCalledTimes(1);
        expect(fixture.feed.drain).toHaveBeenCalledTimes(1);
    });

    test("delegates diff directly and disposes owned feed and path capture resources", async () => {
        const fixture = makeFixture();
        await fixture.tracker.capture({ profile: "pre-turn" });
        fixture.store.diff.mockResolvedValueOnce([
            { path: "a.txt", before: { state: "absent" }, after: { state: "excluded", reason: "ignored" } },
        ]);

        await expect(fixture.tracker.diff(Ref1, Ref2)).resolves.toHaveLength(1);
        expect(fixture.store.diff).toHaveBeenCalledWith(Ref1, Ref2);
        await fixture.tracker.dispose();
        expect(fixture.feed.dispose).toHaveBeenCalledTimes(1);
        expect(fixture.pathCapture.dispose).toHaveBeenCalledTimes(1);
        await expect(fixture.tracker.capture({ profile: "terminal" })).rejects.toThrow(/disposed/i);
    });
});

function makeFixture(
    input: {
        state?: ReturnType<typeof makeStateAccess>;
        hooks?: ConstructorParameters<typeof WorkspaceSnapshotTracker>[0]["hooks"];
    } = {}
) {
    const order: string[] = [];
    const store = {
        storeRoot: "/private/data/repo.git",
        identity: {
            canonicalRoot: "/workspace",
            workspaceIdentity: WorkspaceIdentity,
            workspaceIncarnation: WorkspaceIncarnation,
            storeKey: "test-store",
            ancestorIdentityChain: [],
        },
        git: {} as never,
        captureFullReconcile: vi.fn(async (options) => {
            order.push(`store:full:${options.profile}`);
            return { ref: Ref1, coverage: Coverage };
        }),
        readIncrementalSnapshotMetadata: vi.fn(async (ref) => {
            order.push(`store:metadata:${ref.id[0]}`);
            return Metadata;
        }),
        computeIncrementalSnapshotCoverage: vi.fn(async () => Metadata.coverage),
        commitCapturedIncrementalSnapshot: vi.fn(
            async (_input: Parameters<WorkspaceSnapshotTrackerStore["commitCapturedIncrementalSnapshot"]>[0]) => ({
                ref: Ref2,
                coverage: Coverage,
            })
        ),
        readNodeKind: vi.fn(async () => "leaf" as const),
        verifyOwnedSnapshot: vi.fn(async () => undefined),
        diff: vi.fn(async () => []),
    } satisfies WorkspaceSnapshotTrackerStore;
    const feed = {
        start: vi.fn(async () => {
            order.push("feed:start");
        }),
        drain: vi.fn(async () => {
            order.push("feed:drain");
            return complete([]);
        }),
        isTrusted: vi.fn(() => true),
        dispose: vi.fn(async () => undefined),
    } satisfies WorkspaceChangeFeed;
    const pathCapture = makePathCapture(order);
    const state = input.state ?? makeStateAccess({ status: "untrusted" }, order);
    const makePathCaptureFactory = vi.fn(() => pathCapture);
    const tracker = new WorkspaceSnapshotTracker({
        store,
        feed,
        state,
        makePathCapture: makePathCaptureFactory,
        hooks: input.hooks,
    });
    return {
        tracker,
        store,
        feed,
        pathCapture,
        state,
        makePathCapture: makePathCaptureFactory,
        order,
    };
}

function makePathCapture(order: string[] = []) {
    return {
        capture: vi.fn(async (paths) => {
            order.push(`path:capture:${paths.join(",")}`);
            return captured(...paths);
        }),
        consumeCaptured: vi.fn(async (_result, consumer) => {
            order.push("path:consume");
            return await consumer({ kind: "incremental-captured-batch" });
        }),
        discardCaptured: vi.fn(async () => {
            order.push("path:discard");
        }),
        dispose: vi.fn(async () => undefined),
    } satisfies WorkspaceSnapshotTrackerPathCapture;
}

function makeStateAccess(
    loaded: Awaited<ReturnType<WorkspaceSnapshotTrackerStateAccess["load"]>>,
    order: string[] = []
) {
    return {
        load: vi.fn(async () => {
            order.push("state:load");
            return loaded;
        }),
        publish: vi.fn(async (input) => {
            order.push(`state:publish:${input.current.id[0]}`);
        }),
    } satisfies WorkspaceSnapshotTrackerStateAccess;
}

function snapshot(digit: string): WorkspaceSnapshotRefV1 {
    return {
        id: digit.repeat(40),
        workspaceIdentity: WorkspaceIdentity,
        workspaceIncarnation: WorkspaceIncarnation,
        tree: (Number(digit) + 3).toString().repeat(40),
        scopeManifest: (Number(digit) + 6).toString().repeat(40),
    };
}

function complete(paths: string[]): WorkspaceChangeDrain {
    return { status: "complete", changedPaths: paths };
}

function captured(...paths: string[]): IncrementalPathCaptureResult {
    return {
        status: "captured",
        mutations: paths.map((path) => ({ path, state: { state: "excluded", reason: "ignored" } })),
        newlyHashedBytes: paths.length,
    };
}

function capturedFile(path: string, oidDigit: string): IncrementalPathCaptureResult {
    return {
        status: "captured",
        mutations: [
            {
                path,
                state: { state: "file", oid: oidDigit.repeat(40), executable: false },
            },
        ],
        newlyHashedBytes: 2,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function expectReconcileOrder(fixture: ReturnType<typeof makeFixture>): void {
    const start = fixture.feed.start.mock.invocationCallOrder.at(-1)!;
    const full = fixture.store.captureFullReconcile.mock.invocationCallOrder.at(-1)!;
    expect(start).toBeLessThan(full);
}
