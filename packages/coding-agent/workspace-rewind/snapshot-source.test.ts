// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { initializeWorkspaceCheckpointSnapshotSource, type WorkspaceCheckpointSnapshotSource } from "./snapshot-source";
import type { WorkspaceSnapshotCoverage, WorkspaceSnapshotRefV1 } from "./types";

const WorkspaceIdentity = "a".repeat(64);
const WorkspaceIncarnation = "b".repeat(64);
const BaseCommit = "1".repeat(40);
const ExternalCommit = "2".repeat(40);
const TurnCommit = "3".repeat(40);

function snapshot(id: string, tree = "4".repeat(40)): WorkspaceSnapshotRefV1 {
    return {
        id,
        workspaceIdentity: WorkspaceIdentity,
        workspaceIncarnation: WorkspaceIncarnation,
        tree,
        scopeManifest: "5".repeat(40),
    };
}

const Coverage: WorkspaceSnapshotCoverage = {
    complete: true,
    eligibleEntryCount: 2,
    newlyHashedBytes: 0,
    exclusions: [],
};

function makeStore() {
    const refs = new Map<string, WorkspaceSnapshotRefV1>();
    const trees = new Map<string, string>();
    const metadata = new Map<
        string,
        {
            scope: {
                schemaVersion: 1;
                policy: {
                    maxEntries: number;
                    maxUntrackedBytes: number;
                    gitGlobalExcludes: "disabled-by-isolated-runner";
                };
                ignoreInputs: string[];
                nestedRepositoryBoundaries: string[];
            };
            coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
        }
    >();
    let head: string | undefined;
    const defaultMetadata = () => ({
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
        coverage: {
            complete: true,
            eligibleEntryCount: 2,
            exclusions: [],
        },
    });
    const store = {
        identity: {
            workspaceIdentity: WorkspaceIdentity,
            workspaceIncarnation: WorkspaceIncarnation,
        },
        mutationLog: {
            readHead: vi.fn(async () => head),
            read: vi.fn(async (commit: string) => ({ tree: trees.get(commit) })),
            append: vi.fn(async (input: { tree: string; expectedHead?: string }) => {
                if (head !== input.expectedHead) {
                    throw new Error("Workspace mutation head moved");
                }
                const commit = input.tree === "8".repeat(40) ? TurnCommit : ExternalCommit;
                head = commit;
                trees.set(commit, input.tree);
                return commit;
            }),
        },
        publishCommitSnapshot: vi.fn(async (input: { commit: string }) => {
            const ref = snapshot(input.commit, input.commit === TurnCommit ? "8".repeat(40) : "7".repeat(40));
            refs.set(input.commit, ref);
            return ref;
        }),
        readCommitSnapshot: vi.fn(async (commit: string) => {
            const ref = refs.get(commit);
            if (!ref) throw new Error("missing commit snapshot");
            return ref;
        }),
        readSnapshotMetadata: vi.fn(async (ref: WorkspaceSnapshotRefV1) => metadata.get(ref.id) ?? defaultMetadata()),
        diff: vi.fn(async () => [
            {
                path: "changed.txt",
                before: { state: "absent" as const },
                after: { state: "file" as const, oid: "9".repeat(40), executable: false },
            },
        ]),
    };
    return {
        store,
        seed(ref: WorkspaceSnapshotRefV1) {
            head = ref.id;
            refs.set(ref.id, ref);
            trees.set(ref.id, ref.tree);
        },
        seedHeadWithoutAssociation(commit: string, tree: string) {
            head = commit;
            trees.set(commit, tree);
        },
        setMetadata(refId: string, value: ReturnType<typeof defaultMetadata>) {
            metadata.set(refId, value);
        },
    };
}

describe("Workspace checkpoint snapshot source", () => {
    it("bootstraps a fresh authority as an external mutation before serving no-tool turns", async () => {
        const fixture = makeStore();
        const captured = snapshot("6".repeat(40), "7".repeat(40));
        const legacyCapture = {
            capture: vi.fn(async () => ({ ref: captured, coverage: Coverage })),
        };

        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            legacyCapture,
        });
        const current = await source.readHead();

        expect(legacyCapture.capture).toHaveBeenCalledOnce();
        expect(fixture.store.mutationLog.append).toHaveBeenCalledWith({
            tree: captured.tree,
            metadata: {
                schemaversion: 1,
                workspaceidentity: WorkspaceIdentity,
                workspaceincarnation: WorkspaceIncarnation,
                kind: "external",
            },
        });
        expect(current.ref.id).toBe(ExternalCommit);
        expect(current.coverage).toEqual(Coverage);
    });

    it("shares initialization while the winning authority is not published yet", async () => {
        const fixture = makeStore();
        const winnerCapture = snapshot("6".repeat(40), "7".repeat(40));
        const staleLoserCapture = snapshot("9".repeat(40), "8".repeat(40));
        let markPublicationStarted!: () => void;
        const publicationStarted = new Promise<void>((resolve) => {
            markPublicationStarted = resolve;
        });
        let releasePublication!: () => void;
        const publicationReleased = new Promise<void>((resolve) => {
            releasePublication = resolve;
        });
        const publishCommitSnapshot = fixture.store.publishCommitSnapshot.getMockImplementation()!;
        fixture.store.publishCommitSnapshot.mockImplementation(async (input) => {
            markPublicationStarted();
            await publicationReleased;
            return await publishCommitSnapshot(input);
        });
        const legacyCapture = {
            capture: vi
                .fn()
                .mockResolvedValueOnce({ ref: winnerCapture, coverage: Coverage })
                .mockResolvedValueOnce({ ref: staleLoserCapture, coverage: Coverage }),
        };

        const sourceAPromise = initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            legacyCapture,
        });
        await publicationStarted;
        const sourceBPromise = initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            legacyCapture,
        });
        expect(fixture.store.mutationLog.readHead).toHaveBeenCalledOnce();
        expect(legacyCapture.capture).toHaveBeenCalledOnce();
        releasePublication();
        const [sourceA, sourceB] = await Promise.all([sourceAPromise, sourceBPromise]);

        await expect(Promise.all([sourceA.readHead(), sourceB.readHead()])).resolves.toEqual([
            expect.objectContaining({ ref: expect.objectContaining({ id: ExternalCommit }) }),
            expect.objectContaining({ ref: expect.objectContaining({ id: ExternalCommit }) }),
        ]);
        expect(legacyCapture.capture).toHaveBeenCalledOnce();
        expect(fixture.store.mutationLog.append).toHaveBeenCalledOnce();
    });

    it("opens an existing commit-backed head without scanning the Workspace", async () => {
        const fixture = makeStore();
        fixture.seed(snapshot(BaseCommit));
        const legacyCapture = {
            capture: vi.fn(async () => {
                throw new Error("must not capture");
            }),
        };

        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            legacyCapture,
        });

        await expect(source.readHead()).resolves.toMatchObject({ ref: { id: BaseCommit } });
        expect(legacyCapture.capture).not.toHaveBeenCalled();
    });

    it("records pre-existing drift as external and only net turn changes as an owned commit", async () => {
        const fixture = makeStore();
        fixture.seed(snapshot(BaseCommit, "4".repeat(40)));
        const externalCapture = snapshot("6".repeat(40), "7".repeat(40));
        const turnCapture = snapshot("9".repeat(40), "8".repeat(40));
        const legacyCapture = {
            capture: vi
                .fn()
                .mockResolvedValueOnce({ ref: externalCapture, coverage: Coverage })
                .mockResolvedValueOnce({ ref: turnCapture, coverage: Coverage }),
        };
        const source: WorkspaceCheckpointSnapshotSource = await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            legacyCapture,
        });

        const base = await source.synchronizeExternal();
        const result = await source.captureOwnedTurn({
            base: base.ref,
            sessionId: "session-a",
            turnId: "turn-a",
        });

        expect(fixture.store.mutationLog.append).toHaveBeenNthCalledWith(1, {
            expectedHead: BaseCommit,
            tree: externalCapture.tree,
            metadata: expect.objectContaining({ kind: "external" }),
        });
        expect(fixture.store.mutationLog.append).toHaveBeenNthCalledWith(2, {
            expectedHead: ExternalCommit,
            tree: turnCapture.tree,
            metadata: expect.objectContaining({ kind: "agent-turn", sessionid: "session-a", turnid: "turn-a" }),
        });
        expect(result.after.id).toBe(TurnCommit);
        expect(result.changes).toEqual([expect.objectContaining({ path: "changed.txt" })]);
    });

    it("does not append an empty commit when a writing turn has no net change", async () => {
        const fixture = makeStore();
        const base = snapshot(BaseCommit);
        fixture.seed(base);
        const legacyCapture = {
            capture: vi.fn(async () => ({ ref: snapshot("6".repeat(40), base.tree), coverage: Coverage })),
        };
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            legacyCapture,
        });

        const result = await source.captureOwnedTurn({
            base,
            sessionId: "session-a",
            turnId: "turn-a",
        });

        expect(result).toEqual({ after: base, coverage: Coverage, changes: [] });
        expect(fixture.store.mutationLog.append).not.toHaveBeenCalled();
    });

    it("records a same-tree turn when checkpoint scope semantics changed", async () => {
        const fixture = makeStore();
        const base = snapshot(BaseCommit);
        const captured = snapshot("6".repeat(40), base.tree);
        fixture.seed(base);
        fixture.setMetadata(captured.id, {
            scope: {
                schemaVersion: 1,
                policy: {
                    maxEntries: 200_000,
                    maxUntrackedBytes: 2 * 1024 ** 2,
                    gitGlobalExcludes: "disabled-by-isolated-runner",
                },
                ignoreInputs: [".gitignore"],
                nestedRepositoryBoundaries: [],
            },
            coverage: {
                complete: false,
                eligibleEntryCount: 2,
                exclusions: [{ path: "cache", reason: "ignored" }],
            },
        });
        const legacyCapture = {
            capture: vi.fn(async () => ({
                ref: captured,
                coverage: {
                    complete: false,
                    eligibleEntryCount: 2,
                    newlyHashedBytes: 0,
                    exclusions: [{ path: "cache", reason: "ignored" as const }],
                },
            })),
        };
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            legacyCapture,
        });

        const result = await source.captureOwnedTurn({
            base,
            sessionId: "session-a",
            turnId: "turn-a",
        });

        expect(fixture.store.mutationLog.append).toHaveBeenCalledWith(
            expect.objectContaining({
                expectedHead: BaseCommit,
                tree: base.tree,
                metadata: expect.objectContaining({ kind: "agent-turn" }),
            })
        );
        expect(result.after.id).toBe(ExternalCommit);
    });

    it("repairs a head whose commit publication was interrupted only when live state still matches", async () => {
        const fixture = makeStore();
        const tree = "7".repeat(40);
        fixture.seedHeadWithoutAssociation(ExternalCommit, tree);
        const captured = snapshot("6".repeat(40), tree);
        const legacyCapture = {
            capture: vi.fn(async () => ({ ref: captured, coverage: Coverage })),
        };

        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            legacyCapture,
        });

        await expect(source.readHead()).resolves.toMatchObject({ ref: { id: ExternalCommit, tree } });
        expect(fixture.store.publishCommitSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({ commit: ExternalCommit })
        );
    });
});
