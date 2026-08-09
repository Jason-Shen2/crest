// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import { WorkspaceCandidateCapture } from "./workspace-candidate-capture";
import { resolveCanonicalWorkspaceIdentity } from "./workspace-identity";
import { StablePathReaderConcurrency } from "./workspace-path-reader";
import { discoverWorkspaceScope } from "./workspace-scope";

const CleanupRoots: string[] = [];

afterEach(async () => {
    vi.doUnmock("./workspace-candidate-capture");
    vi.resetModules();
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("V3 snapshot performance contracts", () => {
    test("keeps warm no-change and one-dirty boundaries candidate-local", async () => {
        vi.doMock("./workspace-candidate-capture", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-candidate-capture")>();
            class InMemoryCandidateCapture {
                constructor(readonly input: { base: { readNodeKinds(paths: readonly string[]): Promise<unknown> } }) {}

                async capture(paths: readonly string[]) {
                    if (paths.length > 0) await this.input.base.readNodeKinds(paths);
                    return {
                        status: "captured" as const,
                        entries: paths.map((path) => ({
                            path,
                            state: { state: "file" as const, oid: "9".repeat(40), executable: false },
                        })),
                        newlyHashedBytes: paths.length,
                    };
                }

                async consumeCaptured<T>(_result: unknown, consumer: (batch: { kind: string }) => Promise<T>) {
                    return await consumer({ kind: "workspace-candidate-batch" });
                }

                async discardCaptured(): Promise<void> {}
                async dispose(): Promise<void> {}
            }
            return {
                ...actual,
                WorkspaceCandidateCapture: InMemoryCandidateCapture,
                materializeWorkspaceCandidateBatch: async () => undefined,
            };
        });
        vi.resetModules();
        const [{ initializeWorkspaceCheckpointSnapshotSource }, { WorkspaceGitRunner: IsolatedGitRunner }] =
            await Promise.all([import("./snapshot-source"), import("./git-runner")]);
        const fixture = makeInMemoryAuthorityFixture(IsolatedGitRunner);
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store: fixture.store as never,
            fullReconcile: fixture.fullReconcile,
            candidates: fixture.candidates as never,
        });

        const before = await source.readHead();
        fixture.record([]);
        const warm = await source.synchronizeExternal();

        expect(fixture.fullReconcile).not.toHaveBeenCalled();
        expect(fixture.exactQuota).not.toHaveBeenCalled();
        expect(fixture.readNodeKinds).not.toHaveBeenCalled();
        expect(fixture.gitRun.mock.calls.length).toBeLessThanOrEqual(40);
        expect(warm.ref).toEqual(before.ref);

        fixture.gitRun.mockClear();
        fixture.readNodeKinds.mockClear();
        fixture.record(["file-4.txt"]);
        const dirty = await source.synchronizeExternal();

        expect(fixture.fullReconcile).not.toHaveBeenCalled();
        expect(fixture.exactQuota).not.toHaveBeenCalled();
        expect(fixture.readNodeKinds).toHaveBeenCalledTimes(1);
        expect(fixture.readNodeKinds.mock.calls[0]![1]).toEqual(["file-4.txt"]);
        expect(fixture.gitRun.mock.calls.length).toBeLessThanOrEqual(80);
        expect(dirty.ref.tree).toBe("6".repeat(40));
    });

    test("keeps 100 dirty parent groups candidate-bounded with at most eight stable readers", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-v3-performance-hundred-groups-"));
        CleanupRoots.push(root);
        const workspace = join(root, "workspace");
        const storeRoot = join(root, "repo.git");
        await Promise.all([mkdir(workspace), mkdir(storeRoot)]);
        const identity = await resolveCanonicalWorkspaceIdentity(workspace);
        const nativeGit = new WorkspaceGitRunner();
        const scope = await discoverWorkspaceScope({
            identity,
            git: nativeGit,
            maxEntries: 1_000,
            maxUntrackedBytes: 2 * 1024 ** 2,
        });
        const paths = Array.from({ length: 100 }, (_, index) => `dir-${index}/file.txt`);
        const gitRun = vi.fn(async (args: readonly string[], options: Parameters<WorkspaceGitRunner["run"]>[1]) => {
            if (args[0] !== "hash-object") return await nativeGit.run(args, options);
            const count = options.stdin?.toString("utf8").trimEnd().split("\n").length ?? 0;
            return {
                stdout: Buffer.from(
                    `${Array.from({ length: count }, (_, index) => (index + 1).toString(16).padStart(40, "0")).join("\n")}\n`
                ),
                stderr: Buffer.alloc(0),
            };
        });
        const readNodeKinds = vi.fn(async (candidates: readonly string[]) => {
            return new Map(candidates.map((path) => [path, "absent" as const]));
        });
        let active = 0;
        let peak = 0;
        let workers = 0;
        const capture = new WorkspaceCandidateCapture({
            identity,
            git: { run: gitRun } as unknown as WorkspaceGitRunner,
            storeRoot,
            scope: scope.manifest,
            maxEntries: 1_000,
            maxUntrackedBytes: 2 * 1024 ** 2,
            maxNewlyHashedBytes: 2 * 1024 ** 2,
            timeoutMs: 30_000,
            base: { readNodeKind: async () => "absent", readNodeKinds },
            hooks: {
                workerStarted: () => {
                    workers++;
                    active++;
                    peak = Math.max(peak, active);
                },
                workerSettled: () => active--,
            },
        });
        try {
            for (let index = 0; index < 100; index++) {
                await mkdir(join(workspace, `dir-${index}`));
                await writeFile(join(workspace, paths[index]!), `dirty-${index}`);
            }

            const result = await capture.capture(paths);

            expect(readNodeKinds).toHaveBeenCalledTimes(1);
            expect(readNodeKinds.mock.calls[0]![0]).toHaveLength(100);
            expect(new Set(readNodeKinds.mock.calls[0]![0]).size).toBe(100);
            expect(result).toMatchObject({ status: "captured", entries: { length: 100 } });
            expect(gitRun.mock.calls.length).toBeLessThanOrEqual(8 * 100);
            expect(workers).toBe(100);
            expect(peak).toBe(StablePathReaderConcurrency);
            await capture.discardCaptured(result);
        } finally {
            await capture.dispose();
        }
    }, 30_000);
});

function makeInMemoryAuthorityFixture(GitRunner: typeof WorkspaceGitRunner) {
    const baseCommit = "1".repeat(40);
    const nextCommit = "2".repeat(40);
    const baseTree = "4".repeat(40);
    const dirtyTree = "6".repeat(40);
    const scopeManifest = "5".repeat(40);
    const scope = {
        schemaVersion: 1 as const,
        policy: {
            maxEntries: 200_000,
            maxUntrackedBytes: 2 * 1024 ** 2,
            gitGlobalExcludes: "disabled-by-isolated-runner" as const,
        },
        ignoreInputs: [],
        nestedRepositoryBoundaries: [],
    };
    const coverage = { complete: true, eligibleEntryCount: 1, exclusions: [] };
    const makeRef = (id: string, tree: string) => ({
        id,
        workspaceIdentity: "a".repeat(64),
        workspaceIncarnation: "b".repeat(64),
        tree,
        scopeManifest,
    });
    const refs = new Map([[baseCommit, makeRef(baseCommit, baseTree)]]);
    const trees = new Map([[baseCommit, baseTree]]);
    let head = baseCommit;
    let indexTree = baseTree;
    let pendingPaths: string[] = [];
    const git = new GitRunner();
    const gitRun = vi.spyOn(git, "run").mockImplementation(async (args, options) => {
        if (args[0] === "cat-file" && args[1] === "-t") {
            return { stdout: Buffer.from("tree\n"), stderr: Buffer.alloc(0) };
        }
        if (args[0] === "cat-file" && args[1]?.startsWith("--batch-check=")) {
            const oids = options.stdin!.toString("ascii").trimEnd().split("\n");
            return {
                stdout: Buffer.from(`${oids.map((oid) => `${oid} blob`).join("\n")}\n`),
                stderr: Buffer.alloc(0),
            };
        }
        if (args[0] === "read-tree") {
            indexTree = args[1] === "--empty" ? baseTree : args[1]!;
            return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        }
        if (args[0] === "ls-files") return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        if (args[0] === "update-index") {
            indexTree = dirtyTree;
            return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
        }
        if (args[0] === "write-tree") {
            return { stdout: Buffer.from(`${indexTree}\n`), stderr: Buffer.alloc(0) };
        }
        throw new Error(`Unexpected in-memory Git command: ${args.join(" ")}`);
    });
    const readNodeKinds = vi.fn(async (_base: unknown, paths: readonly string[]) => {
        return new Map(paths.map((path) => [path, "absent" as const]));
    });
    const exactQuota = vi.fn(async () => undefined);
    const fullReconcile = vi.fn(async () => {
        throw new Error("warm candidate path must not full-reconcile");
    });
    const storeRoot = join(
        tmpdir(),
        `crest-v3-performance-memory-${process.pid}-${Date.now()}-${Math.random()}`,
        "repo.git"
    );
    const store = {
        storeRoot,
        identity: {
            canonicalRoot: join(storeRoot, "workspace"),
            workspaceIdentity: "a".repeat(64),
            workspaceIncarnation: "b".repeat(64),
        },
        git,
        quotaAccounting: { reconcileExactUsage: exactQuota },
        mutationLog: {
            readHead: vi.fn(async () => head),
            read: vi.fn(async (commit: string) => ({ tree: trees.get(commit) })),
            prepare: vi.fn(async (input: { tree: string; expectedHead?: string }) => {
                trees.set(nextCommit, input.tree);
                return { commit: nextCommit, expectedHead: input.expectedHead };
            }),
            publishPrepared: vi.fn(async (prepared: { commit: string; expectedHead?: string }) => {
                if (head !== prepared.expectedHead) throw new Error("in-memory authority CAS moved");
                head = prepared.commit;
                return head;
            }),
        },
        publishCommitSnapshot: vi.fn(async (input: { commit: string }) => {
            const ref = makeRef(input.commit, trees.get(input.commit)!);
            refs.set(input.commit, ref);
            return ref;
        }),
        readCommitSnapshot: vi.fn(async (commit: string) => refs.get(commit)),
        readSnapshotMetadata: vi.fn(async () => ({ scope: structuredClone(scope), coverage: { ...coverage } })),
        readNodeKind: vi.fn(async () => "absent" as const),
        readNodeKinds,
        computeCandidateSnapshotCoverage: vi.fn(async () => ({ ...coverage })),
        writeBlob: vi.fn(async () => "9".repeat(40)),
    };
    const candidates = {
        userGit: undefined,
        observationToken: () => 0,
        collect: vi.fn(async () => {
            const paths = pendingPaths;
            pendingPaths = [];
            return { status: "complete" as const, paths, reconciled: false };
        }),
    };
    return {
        candidates,
        exactQuota,
        fullReconcile,
        gitRun,
        readNodeKinds,
        record(paths: string[]) {
            pendingPaths = [...paths];
        },
        store,
    };
}
