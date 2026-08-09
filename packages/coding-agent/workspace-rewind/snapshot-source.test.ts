// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import { ShadowWorkspaceIndex } from "./shadow-workspace-index";
import { initializeWorkspaceCheckpointSnapshotSource, type WorkspaceCheckpointSnapshotSource } from "./snapshot-source";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import type { WorkspaceSnapshotCoverage, WorkspaceSnapshotRefV1 } from "./types";
import { WorkspaceCandidates } from "./workspace-candidates";
import type { WorkspaceChangeDrain, WorkspaceChangeFeed } from "./workspace-change-feed";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";

const WorkspaceIdentity = "a".repeat(64);
const WorkspaceIncarnation = "b".repeat(64);
const BaseCommit = "1".repeat(40);
const ExternalCommit = "2".repeat(40);
const TurnCommit = "3".repeat(40);
const TemporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(TemporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
        storeRoot: "process-local",
        identity: {
            workspaceIdentity: WorkspaceIdentity,
            workspaceIncarnation: WorkspaceIncarnation,
        },
        mutationLog: {
            readHead: vi.fn(async () => head),
            read: vi.fn(async (commit: string) => ({ tree: trees.get(commit) })),
            prepare: vi.fn(async (input: { tree: string; expectedHead?: string }) => {
                const commit = input.tree === "8".repeat(40) ? TurnCommit : ExternalCommit;
                trees.set(commit, input.tree);
                return { commit, expectedHead: input.expectedHead };
            }),
            publishPrepared: vi.fn(async (prepared: { commit: string; expectedHead?: string }) => {
                if (head !== prepared.expectedHead) {
                    throw new Error("Workspace mutation head moved");
                }
                head = prepared.commit;
                return prepared.commit;
            }),
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
            const ref = snapshot(input.commit, trees.get(input.commit));
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

class TestCandidateFeed implements WorkspaceChangeFeed {
    trusted = false;

    async start(): Promise<void> {
        this.trusted = true;
    }

    async drain(): Promise<WorkspaceChangeDrain> {
        return { status: "complete", changedPaths: [] };
    }

    isTrusted(): boolean {
        return this.trusted;
    }

    async dispose(): Promise<void> {
        this.trusted = false;
    }
}

async function testIdentity(root: string): Promise<CanonicalWorkspaceIdentity> {
    const canonicalRoot = await realpath(root);
    const paths: string[] = [];
    for (let current = canonicalRoot; ; current = dirname(current)) {
        paths.push(current);
        if (dirname(current) === current) break;
    }
    const ancestorIdentityChain = await Promise.all(
        paths.reverse().map(async (absolutePath) => {
            const state = await lstat(absolutePath, { bigint: true });
            return {
                absolutePath,
                dev: state.dev.toString(),
                ino: state.ino.toString(),
                birthtimeNs: state.birthtimeNs.toString(),
            };
        })
    );
    return {
        canonicalRoot,
        workspaceIdentity: "d".repeat(64),
        workspaceIncarnation: "e".repeat(64),
        storeKey: "candidate-source",
        ancestorIdentityChain,
    };
}

async function publishUserCommit(
    git: WorkspaceGitRunner,
    workspaceRoot: string,
    bytes: Buffer,
    parent?: string
): Promise<string> {
    const gitDir = join(workspaceRoot, ".git");
    const blob = parseTestOid(
        (
            await git.run(["hash-object", "-w", "--stdin", "--no-filters"], {
                gitDir,
                stdin: bytes,
                timeoutMs: 5_000,
            })
        ).stdout
    );
    const index = new ShadowWorkspaceIndex({ git, gitDir, indexFile: join(gitDir, "index") });
    await index.load();
    await index.apply([{ path: "file.txt", state: { state: "file", oid: blob, executable: false } }]);
    const tree = await index.writeTree();
    const commit = parseTestOid(
        (
            await git.run(["commit-tree", tree, ...(parent ? ["-p", parent] : [])], {
                gitDir,
                stdin: Buffer.from("test\n"),
                timeoutMs: 5_000,
            })
        ).stdout
    );
    await git.run(["update-ref", "HEAD", commit, parent ?? "0".repeat(40)], { gitDir, timeoutMs: 5_000 });
    return commit;
}

function parseTestOid(output: Buffer): string {
    const oid = output.toString("ascii").trim();
    if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error("invalid test oid");
    return oid;
}

describe("Workspace checkpoint snapshot source", () => {
    it("uses candidate-only capture after the one-time non-Git baseline", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-candidate-source-"));
        TemporaryRoots.push(root);
        const workspaceRoot = join(root, "workspace");
        await mkdir(workspaceRoot);
        await writeFile(join(workspaceRoot, "file.txt"), "before");
        const git = new WorkspaceGitRunner();
        const identity = await testIdentity(workspaceRoot);
        const store = await WorkspaceSnapshotStore.open({
            dataRoot: join(root, "data"),
            identity,
            git,
            processOwner: { pid: process.pid, processStartToken: "candidate-source", nonce: "f".repeat(64) },
        });
        const legacyCapture = {
            capture: vi.fn((options) => store.capture(options)),
        };
        const feed = new TestCandidateFeed();
        const candidates = new WorkspaceCandidates({
            workspaceRoot,
            feed,
            reconcile: async () => ["file.txt"],
        });
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store,
            legacyCapture,
            candidates,
        } as never);
        const before = await source.readHead();

        await writeFile(join(workspaceRoot, "file.txt"), "after");
        const after = await source.synchronizeExternal();

        expect(after.ref.tree).not.toBe(before.ref.tree);
        expect(legacyCapture.capture).toHaveBeenCalledOnce();
        await source.dispose?.();
    });

    it("discovers a clean Git HEAD switch from the imported source tree", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-git-candidate-source-"));
        TemporaryRoots.push(root);
        const workspaceRoot = join(root, "workspace");
        await mkdir(workspaceRoot);
        const git = new WorkspaceGitRunner();
        await git.run(["init"], { cwd: workspaceRoot, timeoutMs: 5_000 });
        await writeFile(join(workspaceRoot, "file.txt"), "before");
        const firstCommit = await publishUserCommit(git, workspaceRoot, Buffer.from("before"));
        const identity = await testIdentity(workspaceRoot);
        const store = await WorkspaceSnapshotStore.open({
            dataRoot: join(root, "data"),
            identity,
            git,
            processOwner: { pid: process.pid, processStartToken: "git-candidate-source", nonce: "a".repeat(64) },
        });
        const legacyCapture = { capture: vi.fn((options) => store.capture(options)) };
        const feed = new TestCandidateFeed();
        const candidates = new WorkspaceCandidates({ workspaceRoot, feed, userGit: git, shadowGit: git });
        const source = await initializeWorkspaceCheckpointSnapshotSource({ store, legacyCapture, candidates });
        const before = await source.readHead();

        await publishUserCommit(git, workspaceRoot, Buffer.from("after"), firstCommit);
        await writeFile(join(workspaceRoot, "file.txt"), "after");
        const after = await source.synchronizeExternal();

        expect(after.ref.tree).not.toBe(before.ref.tree);
        expect(legacyCapture.capture).toHaveBeenCalledOnce();
        await source.dispose?.();
    });

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
        expect(fixture.store.mutationLog.prepare).toHaveBeenCalledWith({
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
        expect(fixture.store.mutationLog.publishPrepared).toHaveBeenCalledOnce();
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
        expect(fixture.store.mutationLog.prepare).toHaveBeenCalledOnce();
        expect(fixture.store.mutationLog.publishPrepared).toHaveBeenCalledOnce();
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

        expect(fixture.store.mutationLog.prepare).toHaveBeenNthCalledWith(1, {
            expectedHead: BaseCommit,
            tree: externalCapture.tree,
            metadata: expect.objectContaining({ kind: "external" }),
        });
        expect(fixture.store.mutationLog.prepare).toHaveBeenNthCalledWith(2, {
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
        expect(fixture.store.mutationLog.prepare).not.toHaveBeenCalled();
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

        expect(fixture.store.mutationLog.prepare).toHaveBeenCalledWith(
            expect.objectContaining({
                expectedHead: BaseCommit,
                tree: base.tree,
                metadata: expect.objectContaining({ kind: "agent-turn" }),
            })
        );
        expect(result.after.id).toBe(ExternalCommit);
    });

    it("fails closed for an incomplete head without borrowing live scope metadata", async () => {
        const fixture = makeStore();
        const tree = "7".repeat(40);
        fixture.seedHeadWithoutAssociation(ExternalCommit, tree);
        const captured = snapshot("6".repeat(40), tree);
        fixture.setMetadata(captured.id, {
            scope: {
                schemaVersion: 1,
                policy: {
                    maxEntries: 200_000,
                    maxUntrackedBytes: 2 * 1024 ** 2,
                    gitGlobalExcludes: "disabled-by-isolated-runner",
                },
                ignoreInputs: ["different-scope"],
                nestedRepositoryBoundaries: [],
            },
            coverage: {
                complete: false,
                eligibleEntryCount: 2,
                exclusions: [{ path: "different-scope", reason: "ignored" }],
            },
        });
        const legacyCapture = {
            capture: vi.fn(async () => ({ ref: captured, coverage: Coverage })),
        };

        await expect(
            initializeWorkspaceCheckpointSnapshotSource({
                store: fixture.store as never,
                legacyCapture,
            })
        ).rejects.toThrow(/missing commit snapshot/i);
        expect(legacyCapture.capture).not.toHaveBeenCalled();
        expect(fixture.store.publishCommitSnapshot).not.toHaveBeenCalled();
    });

    it("keeps the previous complete head authoritative until the next association is published", async () => {
        const fixture = makeStore();
        fixture.seed(snapshot(BaseCommit, "4".repeat(40)));
        const captured = snapshot("6".repeat(40), "7".repeat(40));
        const legacyCapture = {
            capture: vi.fn(async () => ({ ref: captured, coverage: Coverage })),
        };
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            legacyCapture,
        });
        let markAssociationStarted!: () => void;
        const associationStarted = new Promise<void>((resolve) => {
            markAssociationStarted = resolve;
        });
        let releaseAssociation!: () => void;
        const associationReleased = new Promise<void>((resolve) => {
            releaseAssociation = resolve;
        });
        const publishCommitSnapshot = fixture.store.publishCommitSnapshot.getMockImplementation()!;
        fixture.store.publishCommitSnapshot.mockImplementation(async (input) => {
            markAssociationStarted();
            await associationReleased;
            return await publishCommitSnapshot(input);
        });

        const synchronization = source.synchronizeExternal();
        await associationStarted;

        await expect(fixture.store.mutationLog.readHead()).resolves.toBe(BaseCommit);
        await expect(source.readHead()).resolves.toMatchObject({ ref: { id: BaseCommit } });

        releaseAssociation();
        await expect(synchronization).resolves.toMatchObject({ ref: { id: ExternalCommit } });
        await expect(fixture.store.mutationLog.readHead()).resolves.toBe(ExternalCommit);
    });

    it("lets a cross-process CAS loser adopt only a completely associated winner", async () => {
        const fixture = makeStore();
        const loserCapture = snapshot("6".repeat(40), "7".repeat(40));
        const winnerCapture = snapshot("9".repeat(40), "8".repeat(40));
        let markLoserAssociationStarted!: () => void;
        const loserAssociationStarted = new Promise<void>((resolve) => {
            markLoserAssociationStarted = resolve;
        });
        let releaseLoserAssociation!: () => void;
        const loserAssociationReleased = new Promise<void>((resolve) => {
            releaseLoserAssociation = resolve;
        });
        const publishCommitSnapshot = fixture.store.publishCommitSnapshot.getMockImplementation()!;
        fixture.store.publishCommitSnapshot.mockImplementation(async (input) => {
            if (input.commit === ExternalCommit) {
                markLoserAssociationStarted();
                await loserAssociationReleased;
            }
            return await publishCommitSnapshot(input);
        });
        const loserPromise = initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            legacyCapture: { capture: vi.fn(async () => ({ ref: loserCapture, coverage: Coverage })) },
        });
        await loserAssociationStarted;
        const winnerStore = { ...fixture.store, storeRoot: "other-process" };
        const winnerOutcome = await initializeWorkspaceCheckpointSnapshotSource({
            store: winnerStore as never,
            legacyCapture: { capture: vi.fn(async () => ({ ref: winnerCapture, coverage: Coverage })) },
        }).then(
            (source) => ({ source }),
            (error: unknown) => ({ error })
        );
        releaseLoserAssociation();
        const loserOutcome = await loserPromise.then(
            (source) => ({ source }),
            (error: unknown) => ({ error })
        );

        if ("error" in winnerOutcome) throw winnerOutcome.error;
        if ("error" in loserOutcome) throw loserOutcome.error;
        await expect(Promise.all([winnerOutcome.source.readHead(), loserOutcome.source.readHead()])).resolves.toEqual([
            expect.objectContaining({ ref: expect.objectContaining({ id: TurnCommit }) }),
            expect.objectContaining({ ref: expect.objectContaining({ id: TurnCommit }) }),
        ]);
    });
});
