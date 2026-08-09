// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

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
const execFileAsync = promisify(execFile);

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

const DefaultScope = {
    schemaVersion: 1 as const,
    policy: {
        maxEntries: 200_000,
        maxUntrackedBytes: 2 * 1024 ** 2,
        gitGlobalExcludes: "disabled-by-isolated-runner" as const,
    },
    ignoreInputs: [],
    nestedRepositoryBoundaries: [],
};

function reconciledSnapshot(ref: WorkspaceSnapshotRefV1, coverage = Coverage) {
    return { tree: ref.tree, scope: structuredClone(DefaultScope), coverage: structuredClone(coverage) };
}

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
    changedPaths: string[] = [];
    drainCalls = 0;
    beforeDrain?: (call: number) => Promise<void>;

    record(path: string): void {
        this.changedPaths.push(path);
    }

    async start(): Promise<void> {
        this.trusted = true;
    }

    async drain(): Promise<WorkspaceChangeDrain> {
        this.drainCalls++;
        await this.beforeDrain?.(this.drainCalls);
        const changedPaths = this.changedPaths;
        this.changedPaths = [];
        return { status: "complete", changedPaths };
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

async function commitAll(git: WorkspaceGitRunner, repositoryRoot: string, message: string): Promise<void> {
    void git;
    await execFileAsync("git", ["add", "--all"], { cwd: repositoryRoot });
    await execFileAsync(
        "git",
        ["-c", "user.name=Crest Tests", "-c", "user.email=crest@example.invalid", "commit", "-m", message],
        { cwd: repositoryRoot }
    );
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
        const fullReconcile = vi.fn((options) => store.captureFullReconcile(options));
        const feed = new TestCandidateFeed();
        const candidates = new WorkspaceCandidates({
            workspaceRoot,
            feed,
            reconcile: async () => ["file.txt"],
        });
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store,
            fullReconcile,
            candidates,
        } as never);
        const before = await source.readHead();

        await writeFile(join(workspaceRoot, "file.txt"), "after");
        feed.record("file.txt");
        const after = await source.synchronizeExternal();

        expect(after.ref.tree).not.toBe(before.ref.tree);
        expect(fullReconcile).toHaveBeenCalledOnce();
        await source.dispose?.();
    });

    it("full-reconciles after candidate discovery drains a scope-invalidating change", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-candidate-scope-fallback-"));
        TemporaryRoots.push(root);
        const workspaceRoot = join(root, "workspace");
        await mkdir(workspaceRoot);
        await writeFile(join(workspaceRoot, "file.txt"), "tracked");
        const git = new WorkspaceGitRunner();
        const identity = await testIdentity(workspaceRoot);
        const store = await WorkspaceSnapshotStore.open({
            dataRoot: join(root, "data"),
            identity,
            git,
            processOwner: { pid: process.pid, processStartToken: "candidate-fallback", nonce: "1".repeat(64) },
        });
        const fullReconcile = vi.spyOn(store, "captureFullReconcile");
        const feed = new TestCandidateFeed();
        const candidates = new WorkspaceCandidates({
            workspaceRoot,
            feed,
            reconcile: async () => [".gitignore", "file.txt"],
        });
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store,
            fullReconcile: (options) => store.captureFullReconcile(options),
            candidates,
        });
        const before = await source.readHead();

        await writeFile(join(workspaceRoot, ".gitignore"), "file.txt\n");
        feed.record(".gitignore");
        const after = await source.synchronizeExternal();

        expect(after.ref.tree).not.toBe(before.ref.tree);
        expect(after.coverage.eligibleEntryCount).toBe(1);
        expect(fullReconcile).toHaveBeenCalledTimes(2);
        await source.dispose?.();
    });

    it("recaptures the union when a new path changes during candidate capture", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-candidate-post-validate-"));
        TemporaryRoots.push(root);
        const workspaceRoot = join(root, "workspace");
        await mkdir(workspaceRoot);
        await writeFile(join(workspaceRoot, "a.txt"), "a-before");
        await writeFile(join(workspaceRoot, "b.txt"), "b-before");
        const git = new WorkspaceGitRunner();
        const identity = await testIdentity(workspaceRoot);
        const store = await WorkspaceSnapshotStore.open({
            dataRoot: join(root, "data"),
            identity,
            git,
            processOwner: { pid: process.pid, processStartToken: "candidate-validation", nonce: "2".repeat(64) },
        });
        const feed = new TestCandidateFeed();
        const candidates = new WorkspaceCandidates({ workspaceRoot, feed, reconcile: async () => ["a.txt"] });
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store,
            fullReconcile: (options) => store.captureFullReconcile(options),
            candidates,
        });
        const before = await source.readHead();
        const readNodeKinds = store.readNodeKinds.bind(store);
        let injected = false;
        vi.spyOn(store, "readNodeKinds").mockImplementation(async (...args) => {
            const result = await readNodeKinds(...args);
            if (!injected) {
                injected = true;
                await writeFile(join(workspaceRoot, "b.txt"), "b-during-capture");
                feed.record("b.txt");
            }
            return result;
        });

        await writeFile(join(workspaceRoot, "a.txt"), "a-after");
        feed.record("a.txt");
        const after = await source.synchronizeExternal();

        await expect(store.diff(before.ref, after.ref)).resolves.toEqual([
            expect.objectContaining({ path: "a.txt" }),
            expect.objectContaining({ path: "b.txt" }),
        ]);
        await source.dispose?.();
    });

    it("recaptures a same-path watcher observation and commits the latest stable bytes", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-candidate-same-path-"));
        TemporaryRoots.push(root);
        const workspaceRoot = join(root, "workspace");
        await mkdir(workspaceRoot);
        await writeFile(join(workspaceRoot, "a.txt"), "a-before");
        const git = new WorkspaceGitRunner();
        const identity = await testIdentity(workspaceRoot);
        const store = await WorkspaceSnapshotStore.open({
            dataRoot: join(root, "data"),
            identity,
            git,
            processOwner: { pid: process.pid, processStartToken: "candidate-same-path", nonce: "4".repeat(64) },
        });
        const feed = new TestCandidateFeed();
        const candidates = new WorkspaceCandidates({ workspaceRoot, feed, reconcile: async () => ["a.txt"] });
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store,
            fullReconcile: (options) => store.captureFullReconcile(options),
            candidates,
        });
        feed.beforeDrain = async (call) => {
            if (call === 2) {
                await writeFile(join(workspaceRoot, "a.txt"), "a-v2");
                feed.record("a.txt");
            }
        };

        await writeFile(join(workspaceRoot, "a.txt"), "a-v1");
        const after = await source.synchronizeExternal();
        const state = await store.readPathState(after.ref, "a.txt");

        expect(state).toMatchObject({ state: "file" });
        await expect(store.readBlob((state as { oid: string }).oid)).resolves.toEqual(Buffer.from("a-v2"));
        await source.dispose?.();
    });

    it("fails closed when paths keep changing during the single candidate recapture", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-candidate-continuous-change-"));
        TemporaryRoots.push(root);
        const workspaceRoot = join(root, "workspace");
        await mkdir(workspaceRoot);
        await writeFile(join(workspaceRoot, "a.txt"), "a-before");
        await writeFile(join(workspaceRoot, "b.txt"), "b-before");
        await writeFile(join(workspaceRoot, "c.txt"), "c-before");
        const git = new WorkspaceGitRunner();
        const identity = await testIdentity(workspaceRoot);
        const store = await WorkspaceSnapshotStore.open({
            dataRoot: join(root, "data"),
            identity,
            git,
            processOwner: { pid: process.pid, processStartToken: "candidate-continuous", nonce: "3".repeat(64) },
        });
        const feed = new TestCandidateFeed();
        const candidates = new WorkspaceCandidates({ workspaceRoot, feed, reconcile: async () => ["a.txt"] });
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store,
            fullReconcile: (options) => store.captureFullReconcile(options),
            candidates,
        });
        const before = await source.readHead();
        const readNodeKinds = store.readNodeKinds.bind(store);
        let captureAttempt = 0;
        vi.spyOn(store, "readNodeKinds").mockImplementation(async (...args) => {
            const result = await readNodeKinds(...args);
            captureAttempt++;
            const changed = captureAttempt === 1 ? "b.txt" : "c.txt";
            await writeFile(join(workspaceRoot, changed), `${changed}-during-capture`);
            feed.record(changed);
            return result;
        });

        await writeFile(join(workspaceRoot, "a.txt"), "a-after");
        feed.record("a.txt");
        await expect(source.synchronizeExternal()).rejects.toThrow(/changed during candidate capture/i);
        await expect(source.readHead()).resolves.toMatchObject({ ref: { id: before.ref.id } });
        await source.dispose?.();
    });

    it("fails closed when the same path changes again during the single recapture", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-candidate-same-path-continuous-"));
        TemporaryRoots.push(root);
        const workspaceRoot = join(root, "workspace");
        await mkdir(workspaceRoot);
        await writeFile(join(workspaceRoot, "a.txt"), "a-before");
        const git = new WorkspaceGitRunner();
        const identity = await testIdentity(workspaceRoot);
        const store = await WorkspaceSnapshotStore.open({
            dataRoot: join(root, "data"),
            identity,
            git,
            processOwner: { pid: process.pid, processStartToken: "candidate-same-path-loop", nonce: "5".repeat(64) },
        });
        const feed = new TestCandidateFeed();
        const candidates = new WorkspaceCandidates({ workspaceRoot, feed, reconcile: async () => ["a.txt"] });
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store,
            fullReconcile: (options) => store.captureFullReconcile(options),
            candidates,
        });
        const before = await source.readHead();
        feed.beforeDrain = async (call) => {
            if (call !== 2 && call !== 3) return;
            await writeFile(join(workspaceRoot, "a.txt"), call === 2 ? "a-v2" : "a-v3");
            feed.record("a.txt");
        };

        await writeFile(join(workspaceRoot, "a.txt"), "a-v1");
        await expect(source.synchronizeExternal()).rejects.toThrow(/changed during candidate capture/i);
        await expect(source.readHead()).resolves.toMatchObject({ ref: { id: before.ref.id } });
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
        const fullReconcile = vi.fn((options) => store.captureFullReconcile(options));
        const feed = new TestCandidateFeed();
        const candidates = new WorkspaceCandidates({
            workspaceRoot: identity.canonicalRoot,
            feed,
            userGit: git,
            shadowGit: git,
        });
        const source = await initializeWorkspaceCheckpointSnapshotSource({ store, fullReconcile, candidates });
        const before = await source.readHead();

        await publishUserCommit(git, workspaceRoot, Buffer.from("after"), firstCommit);
        await writeFile(join(workspaceRoot, "file.txt"), "after");
        const after = await source.synchronizeExternal();

        expect(after.ref.tree).not.toBe(before.ref.tree);
        expect(fullReconcile).toHaveBeenCalledOnce();
        await source.dispose?.();
    });

    it("captures only a nested monorepo workspace with a literal non-ASCII prefix", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-nested-git-candidate-source-"));
        TemporaryRoots.push(root);
        const repositoryRoot = join(root, "monorepo");
        const workspaceRoot = join(repositoryRoot, "sub workspace-λ");
        await mkdir(workspaceRoot, { recursive: true });
        await mkdir(join(repositoryRoot, "sibling"));
        const git = new WorkspaceGitRunner();
        await git.run(["init"], { cwd: repositoryRoot, timeoutMs: 5_000 });
        await writeFile(join(workspaceRoot, "tracked.txt"), "base\n");
        await writeFile(join(repositoryRoot, "sibling", "outside.txt"), "base\n");
        await commitAll(git, repositoryRoot, "base");
        const identity = await testIdentity(workspaceRoot);
        const store = await WorkspaceSnapshotStore.open({
            dataRoot: join(root, "data"),
            identity,
            git,
            processOwner: { pid: process.pid, processStartToken: "nested-git-source", nonce: "6".repeat(64) },
        });
        const fullReconcile = vi.fn((options) => store.captureFullReconcile(options));
        const candidates = new WorkspaceCandidates({
            workspaceRoot: identity.canonicalRoot,
            feed: new TestCandidateFeed(),
            userGit: git,
            shadowGit: git,
        });
        const source = await initializeWorkspaceCheckpointSnapshotSource({ store, fullReconcile, candidates });
        const before = await source.readHead();

        await writeFile(join(workspaceRoot, "tracked.txt"), "committed after\n");
        await writeFile(join(repositoryRoot, "sibling", "outside.txt"), "sibling after\n");
        await commitAll(git, repositoryRoot, "nested and sibling change");
        const after = await source.synchronizeExternal();

        await expect(store.diff(before.ref, after.ref)).resolves.toEqual([
            expect.objectContaining({ path: "tracked.txt" }),
        ]);
        expect(fullReconcile).toHaveBeenCalledOnce();
        await source.dispose?.();
    });

    it("batch-checks wide stable siblings while importing only the missing source-tree chain", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-pruned-source-import-"));
        TemporaryRoots.push(root);
        const workspaceRoot = join(root, "workspace");
        const stableSiblingCount = 32;
        await mkdir(join(workspaceRoot, "changed"), { recursive: true });
        const git = new WorkspaceGitRunner();
        await git.run(["init"], { cwd: workspaceRoot, timeoutMs: 5_000 });
        await writeFile(join(workspaceRoot, "changed", "leaf.txt"), "before\n");
        for (let index = 0; index < stableSiblingCount; index++) {
            const stable = join(workspaceRoot, `stable-${index.toString().padStart(2, "0")}`);
            await mkdir(stable);
            await writeFile(join(stable, "leaf.txt"), `stable ${index}\n`);
        }
        await commitAll(git, workspaceRoot, "base");
        const stableTrees: string[] = [];
        for (let index = 0; index < stableSiblingCount; index++) {
            const name = `stable-${index.toString().padStart(2, "0")}`;
            stableTrees.push(
                parseTestOid(
                    (await git.run(["rev-parse", `HEAD:${name}`], { cwd: workspaceRoot, timeoutMs: 5_000 })).stdout
                )
            );
        }
        const stableTree = stableTrees[0]!;
        const identity = await testIdentity(workspaceRoot);
        const store = await WorkspaceSnapshotStore.open({
            dataRoot: join(root, "data"),
            identity,
            git,
            processOwner: { pid: process.pid, processStartToken: "pruned-source-import", nonce: "7".repeat(64) },
        });
        const candidates = new WorkspaceCandidates({
            workspaceRoot: identity.canonicalRoot,
            feed: new TestCandidateFeed(),
            userGit: git,
            shadowGit: git,
        });
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store,
            fullReconcile: (options) => store.captureFullReconcile(options),
            candidates,
        });
        await writeFile(join(workspaceRoot, "changed", "leaf.txt"), "after\n");
        await commitAll(git, workspaceRoot, "change one leaf");
        const sourceTree = parseTestOid(
            (await git.run(["rev-parse", "HEAD^{tree}"], { cwd: workspaceRoot, timeoutMs: 5_000 })).stdout
        );
        const changedTree = parseTestOid(
            (await git.run(["rev-parse", "HEAD:changed"], { cwd: workspaceRoot, timeoutMs: 5_000 })).stdout
        );
        const userCatFileTrees: string[] = [];
        const privateBatchChecks: string[][] = [];
        let corruptPrivateTreeLookup = false;
        const run = git.run.bind(git);
        vi.spyOn(git, "run").mockImplementation(async (args, options) => {
            if (
                corruptPrivateTreeLookup &&
                args[0] === "cat-file" &&
                args[1]?.startsWith("--batch-check=") &&
                options.gitDir
            ) {
                const requested = options.stdin!.toString("ascii").trim();
                return { stdout: Buffer.from(`${requested} blob\n`), stderr: Buffer.alloc(0) };
            }
            if (args[0] === "cat-file" && args[1]?.startsWith("--batch-check=") && options.gitDir) {
                privateBatchChecks.push(options.stdin!.toString("ascii").trim().split("\n"));
            }
            if (args[0] === "cat-file" && args[1] === "tree" && options.cwd === identity.canonicalRoot) {
                userCatFileTrees.push(args[2]!);
            }
            return await run(args, options);
        });

        await source.synchronizeExternal();

        expect(userCatFileTrees).toEqual([sourceTree, changedTree]);
        expect(userCatFileTrees).not.toContain(stableTree);
        expect(privateBatchChecks).toHaveLength(8);
        const childTrees = new Set([changedTree, ...stableTrees]);
        const importChildChecks = privateBatchChecks.filter((batch) => batch.some((oid) => childTrees.has(oid)));
        expect(importChildChecks).toEqual([expect.arrayContaining([...childTrees])]);
        expect(importChildChecks[0]).toHaveLength(stableSiblingCount + 1);

        await writeFile(join(workspaceRoot, "changed", "leaf.txt"), "after again\n");
        await commitAll(git, workspaceRoot, "change leaf again");
        corruptPrivateTreeLookup = true;
        await expect(source.synchronizeExternal()).rejects.toThrow(/invalid object result/i);
        await source.dispose?.();
    }, 20_000);

    it("bootstraps a fresh authority as an external mutation before serving no-tool turns", async () => {
        const fixture = makeStore();
        const captured = snapshot("6".repeat(40), "7".repeat(40));
        const fullReconcile = vi.fn(async () => reconciledSnapshot(captured));

        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            fullReconcile,
        });
        const current = await source.readHead();

        expect(fullReconcile).toHaveBeenCalledOnce();
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

    it("adopts a fresh candidate baseline after a CAS winner proves equivalent", async () => {
        const fixture = makeStore();
        const captured = snapshot("6".repeat(40), "7".repeat(40));
        const winner = snapshot(TurnCommit, captured.tree);
        const candidates = makeInitializationCandidates();
        fixture.store.mutationLog.publishPrepared.mockImplementationOnce(async () => {
            fixture.seed(winner);
            throw new Error("Workspace mutation head moved");
        });

        await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            fullReconcile: vi.fn(async () => reconciledSnapshot(captured)),
            candidates: candidates.value,
        });

        expect(candidates.startNonGitBaselineObservation).toHaveBeenCalledOnce();
        expect(candidates.adoptNonGitBaseline).toHaveBeenCalledOnce();
    });

    it("keeps a fresh candidate baseline cold when a CAS winner has different snapshot semantics", async () => {
        const fixture = makeStore();
        const captured = snapshot("6".repeat(40), "7".repeat(40));
        const winner = snapshot(TurnCommit, "8".repeat(40));
        const candidates = makeInitializationCandidates();
        fixture.store.mutationLog.publishPrepared.mockImplementationOnce(async () => {
            fixture.seed(winner);
            throw new Error("Workspace mutation head moved");
        });

        await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            fullReconcile: vi.fn(async () => reconciledSnapshot(captured)),
            candidates: candidates.value,
        });

        expect(candidates.startNonGitBaselineObservation).toHaveBeenCalledOnce();
        expect(candidates.adoptNonGitBaseline).not.toHaveBeenCalled();
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
        const fullReconcile = vi
            .fn()
            .mockResolvedValueOnce(reconciledSnapshot(winnerCapture))
            .mockResolvedValueOnce(reconciledSnapshot(staleLoserCapture));

        const sourceAPromise = initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            fullReconcile,
        });
        await publicationStarted;
        const sourceBPromise = initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            fullReconcile,
        });
        expect(fixture.store.mutationLog.readHead).toHaveBeenCalledOnce();
        expect(fullReconcile).toHaveBeenCalledOnce();
        releasePublication();
        const [sourceA, sourceB] = await Promise.all([sourceAPromise, sourceBPromise]);

        await expect(Promise.all([sourceA.readHead(), sourceB.readHead()])).resolves.toEqual([
            expect.objectContaining({ ref: expect.objectContaining({ id: ExternalCommit }) }),
            expect.objectContaining({ ref: expect.objectContaining({ id: ExternalCommit }) }),
        ]);
        expect(fullReconcile).toHaveBeenCalledOnce();
        expect(fixture.store.mutationLog.prepare).toHaveBeenCalledOnce();
        expect(fixture.store.mutationLog.publishPrepared).toHaveBeenCalledOnce();
    });

    it("opens an existing commit-backed head without scanning the Workspace", async () => {
        const fixture = makeStore();
        fixture.seed(snapshot(BaseCommit));
        const fullReconcile = vi.fn(async () => {
            throw new Error("must not capture");
        });

        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            fullReconcile,
        });

        await expect(source.readHead()).resolves.toMatchObject({ ref: { id: BaseCommit } });
        expect(fullReconcile).not.toHaveBeenCalled();
    });

    it("records pre-existing drift as external and only net turn changes as an owned commit", async () => {
        const fixture = makeStore();
        fixture.seed(snapshot(BaseCommit, "4".repeat(40)));
        const externalCapture = snapshot("6".repeat(40), "7".repeat(40));
        const turnCapture = snapshot("9".repeat(40), "8".repeat(40));
        const fullReconcile = vi
            .fn()
            .mockResolvedValueOnce(reconciledSnapshot(externalCapture))
            .mockResolvedValueOnce(reconciledSnapshot(turnCapture));
        const source: WorkspaceCheckpointSnapshotSource = await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            fullReconcile,
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
        const fullReconcile = vi.fn(async () => reconciledSnapshot(snapshot("6".repeat(40), base.tree)));
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            fullReconcile,
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
                ignoreInputs: [
                    {
                        source: "gitignore" as const,
                        path: ".gitignore",
                        contentHash: "a".repeat(64),
                    },
                ],
                nestedRepositoryBoundaries: [],
            },
            coverage: {
                complete: false,
                eligibleEntryCount: 2,
                exclusions: [{ path: "cache", reason: "ignored" }],
            },
        });
        const fullReconcile = vi.fn(async () => ({
            tree: captured.tree,
            scope: {
                ...structuredClone(DefaultScope),
                ignoreInputs: [
                    {
                        source: "gitignore" as const,
                        path: ".gitignore",
                        contentHash: "a".repeat(64),
                    },
                ],
            },
            coverage: {
                complete: false,
                eligibleEntryCount: 2,
                newlyHashedBytes: 0,
                exclusions: [{ path: "cache", reason: "ignored" as const }],
            },
        }));
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            fullReconcile,
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
        const fullReconcile = vi.fn(async () => reconciledSnapshot(captured));

        await expect(
            initializeWorkspaceCheckpointSnapshotSource({
                store: fixture.store as never,
                fullReconcile,
            })
        ).rejects.toThrow(/missing commit snapshot/i);
        expect(fullReconcile).not.toHaveBeenCalled();
        expect(fixture.store.publishCommitSnapshot).not.toHaveBeenCalled();
    });

    it("keeps the previous complete head authoritative until the next association is published", async () => {
        const fixture = makeStore();
        fixture.seed(snapshot(BaseCommit, "4".repeat(40)));
        const captured = snapshot("6".repeat(40), "7".repeat(40));
        const fullReconcile = vi.fn(async () => reconciledSnapshot(captured));
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            fullReconcile,
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
            fullReconcile: vi.fn(async () => reconciledSnapshot(loserCapture)),
        });
        await loserAssociationStarted;
        const winnerStore = { ...fixture.store, storeRoot: "other-process" };
        const winnerOutcome = await initializeWorkspaceCheckpointSnapshotSource({
            store: winnerStore as never,
            fullReconcile: vi.fn(async () => reconciledSnapshot(winnerCapture)),
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

function makeInitializationCandidates() {
    const startNonGitBaselineObservation = vi.fn(async () => true);
    const adoptNonGitBaseline = vi.fn(() => true);
    return {
        adoptNonGitBaseline,
        startNonGitBaselineObservation,
        value: {
            adoptNonGitBaseline,
            startNonGitBaselineObservation,
        } as never,
    };
}
