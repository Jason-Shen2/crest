// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import { makeProcessOwnerIdentity } from "./process-owner";
import { initializePrivateStore, WorkspaceSnapshotStore } from "./snapshot-store";
import { resolveCanonicalWorkspaceIdentity } from "./workspace-identity";

const TemporaryRoots: string[] = [];
const OriginalDataHome = process.env.WAVETERM_DATA_HOME;

afterEach(async () => {
    if (OriginalDataHome == null) delete process.env.WAVETERM_DATA_HOME;
    else process.env.WAVETERM_DATA_HOME = OriginalDataHome;
    await Promise.all(TemporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceSnapshotStore V3 authority", () => {
    it("full-reconciles directly to a raw workspace tree with scope and coverage", async () => {
        const fixture = await makeFixture();
        const reconciled = await fixture.store.captureFullReconcile({ profile: "terminal" });

        expect(reconciled).toMatchObject({
            tree: expect.stringMatching(/^[0-9a-f]+$/),
            scope: {
                schemaVersion: 1,
                policy: { gitGlobalExcludes: "disabled-by-isolated-runner" },
            },
            coverage: {
                complete: false,
                eligibleEntryCount: 4,
                newlyHashedBytes: expect.any(Number),
                exclusions: [expect.objectContaining({ path: "cache", reason: "ignored" })],
            },
        });
        expect(await fixture.store.mutationLog.readHead()).toBeUndefined();
    });

    it("reads one hundred candidate node kinds with a fixed Git-call bound", async () => {
        const { fixture, after, paths } = await makeHundredChangedCandidates();
        const run = vi.spyOn(fixture.store.git, "run");

        const kinds = await fixture.store.readNodeKinds(after.ref, paths);

        expect([...kinds.values()]).toEqual(Array.from({ length: 100 }, () => "leaf"));
        expect(run).toHaveBeenCalledTimes(5);
        expect(run.mock.calls.slice(-2).map(([args]) => args.slice(0, 2))).toEqual([
            ["ls-tree", "-z"],
            ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
        ]);
    });

    it("batches distributed candidates by depth and preserves ancestor and descendant nodes", async () => {
        const fixture = await makeFixture();
        const paths = Array.from({ length: 100 }, (_, index) => `distributed-${index}/file.txt`);
        await Promise.all(
            paths.map(async (path) => {
                await mkdir(dirname(join(fixture.workspace, path)), { recursive: true });
                await writeFile(join(fixture.workspace, path), "value");
            })
        );
        const captured = await fixture.store.capture({ profile: "terminal" });
        const requested = ["distributed-0", ...paths];
        const run = vi.spyOn(fixture.store.git, "run");

        const kinds = await fixture.store.readNodeKinds(captured.ref, requested);

        expect(kinds.get("distributed-0")).toBe("tree");
        expect(paths.map((path) => kinds.get(path))).toEqual(Array.from({ length: 100 }, () => "leaf"));
        expect(run).toHaveBeenCalledTimes(6);
        expect(run.mock.calls.filter(([args]) => args[0] === "ls-tree")).toHaveLength(2);
    }, 30_000);

    it("derives coverage for one hundred candidates with a fixed Git-call bound", async () => {
        const { fixture, before, after, candidates } = await makeHundredChangedCandidates();
        const run = vi.spyOn(fixture.store.git, "run");

        const coverage = await fixture.store.computeCandidateSnapshotCoverage(before.ref, after.ref.tree, candidates);

        expect(coverage).toEqual({
            complete: after.coverage.complete,
            eligibleEntryCount: after.coverage.eligibleEntryCount,
            exclusions: after.coverage.exclusions,
        });
        expect(run).toHaveBeenCalledTimes(4);
        expect(run).toHaveBeenCalledWith(
            expect.arrayContaining(["diff-tree"]),
            expect.objectContaining({ gitDir: fixture.store.storeRoot })
        );
    });

    it("updates only candidate path exclusions when deriving coverage", async () => {
        const fixture = await makeFixture();
        await writeFile(join(fixture.workspace, ".gitignore"), "cache\ncache-keep\n");
        await mkdir(join(fixture.workspace, "cache-keep"));
        await writeFile(join(fixture.workspace, "cache-keep", "ignored.txt"), "ignored");
        const captured = await fixture.store.capture({ profile: "terminal" });
        const base = await fixture.store.readSnapshotMetadata(captured.ref);

        const cleared = await fixture.store.computeCandidateSnapshotCoverage(captured.ref, captured.ref.tree, [
            { path: "cache", state: { state: "absent" } },
        ]);
        const restored = await fixture.store.computeCandidateSnapshotCoverage(captured.ref, captured.ref.tree, [
            { path: "cache", state: { state: "excluded", reason: "untracked-too-large" } },
        ]);

        expect(base.coverage.exclusions).toEqual(
            expect.arrayContaining([
                { path: "cache", reason: "ignored" },
                { path: "cache-keep", reason: "ignored" },
            ])
        );
        expect(cleared.exclusions).not.toContainEqual(expect.objectContaining({ path: "cache" }));
        expect(cleared.exclusions).toContainEqual({ path: "cache-keep", reason: "ignored" });
        expect(restored.exclusions).toContainEqual({ path: "cache", reason: "untracked-too-large" });
        expect(restored.exclusions).toContainEqual({ path: "cache-keep", reason: "ignored" });
    });

    it("publishes only a compact V3 manifest and preserves exact raw bytes", async () => {
        const fixture = await makeFixture();
        const binary = Buffer.from([0, 255, 13, 10, 128]);
        await writeFile(join(fixture.workspace, "plain.txt"), binary);

        const captured = await fixture.store.capture({ profile: "terminal" });
        const manifestBytes = await fixture.store.readBlob(captured.ref.scopeManifest);
        const manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;

        expect(manifest).toMatchObject({
            schemaversion: 3,
            workspaceidentity: fixture.store.identity.workspaceIdentity,
            workspaceincarnation: fixture.store.identity.workspaceIncarnation,
        });
        expect(Object.keys(manifest).sort()).toEqual([
            "coverage",
            "schemaversion",
            "scope",
            "workspaceidentity",
            "workspaceincarnation",
        ]);
        const state = await fixture.store.readPathState(captured.ref, "plain.txt");
        expect(state).toMatchObject({ state: "file", executable: false });
        if (state.state !== "file") throw new Error("expected a file state");
        expect(await fixture.store.readBlob(state.oid)).toEqual(binary);
        await expect(fixture.store.verifyOwnedSnapshot(captured.ref)).resolves.toBeUndefined();
    });

    it("diffs commit-backed V3 trees across files, executable bits, links, and removals", async () => {
        const fixture = await makeFixture();
        const before = await fixture.store.capture({ profile: "terminal" });

        await writeFile(join(fixture.workspace, "plain.txt"), "after\r\n");
        await chmod(join(fixture.workspace, "tool.sh"), 0o755);
        await rm(join(fixture.workspace, "link"));
        await writeFile(join(fixture.workspace, "link"), "link replaced by file");
        await symlink("plain.txt", join(fixture.workspace, "new-link"));
        const after = await fixture.store.capture({ profile: "terminal" });

        const changes = await fixture.store.diff(before.ref, after.ref);
        expect(changes.map((change) => change.path)).toEqual([
            "link",
            "new-link",
            "plain.txt",
            "tool.sh",
        ]);
        expect(changes.find((change) => change.path === "link")).toMatchObject({
            before: { state: "symlink" },
            after: { state: "file", executable: false },
        });
        expect(await fixture.store.readPathState(after.ref, "tool.sh")).toMatchObject({
            state: "file",
            executable: true,
        });
        expect(await readFile(join(fixture.workspace, "plain.txt"))).toEqual(Buffer.from("after\r\n"));
    });

    it("diffs one hundred changed paths with a fixed Git-call bound", async () => {
        const { fixture, before, after, paths } = await makeHundredChangedCandidates();
        const run = vi.spyOn(fixture.store.git, "run");

        const changes = await fixture.store.diff(before.ref, after.ref);

        expect(changes.map((change) => change.path)).toEqual(paths.sort(compareTestPaths));
        expect(run).toHaveBeenCalledTimes(8);
        expect(run.mock.calls.map(([args]) => args[0])).toEqual([
            "cat-file",
            "cat-file",
            "cat-file",
            "cat-file",
            "cat-file",
            "cat-file",
            "diff-tree",
            "cat-file",
        ]);
    });

    it("preserves ancestor exclusion semantics when a path becomes captured", async () => {
        const fixture = await makeFixture();
        const before = await fixture.store.capture({ profile: "terminal" });
        await writeFile(join(fixture.workspace, ".gitignore"), "");
        const after = await fixture.store.capture({ profile: "terminal" });

        const changes = await fixture.store.diff(before.ref, after.ref);

        expect(changes.find((change) => change.path === "cache")).toEqual({
            path: "cache",
            before: { state: "excluded", reason: "ignored" },
            after: { state: "absent" },
        });
        expect(changes.find((change) => change.path === "cache/ignored.txt")).toMatchObject({
            before: { state: "excluded", reason: "ignored" },
            after: { state: "file", executable: false },
        });
    });

    it("fails closed for malformed raw tree deltas and missing objects", async () => {
        const fixture = await makeFixture();
        const before = await fixture.store.capture({ profile: "terminal" });
        await writeFile(join(fixture.workspace, "plain.txt"), "after");
        const after = await fixture.store.capture({ profile: "terminal" });
        const beforeState = await fixture.store.readPathState(before.ref, "plain.txt");
        const afterState = await fixture.store.readPathState(after.ref, "plain.txt");
        if (beforeState.state !== "file" || afterState.state !== "file") throw new Error("expected file states");
        const zeroOid = "0".repeat(beforeState.oid.length);
        const validHeader = `:100644 100644 ${beforeState.oid} ${afterState.oid} M`;
        const record = (header: string, path = Buffer.from("plain.txt")) =>
            Buffer.concat([Buffer.from(header), Buffer.from([0]), path, Buffer.from([0])]);
        const originalRun = fixture.store.git.run.bind(fixture.store.git);
        let injected = Buffer.alloc(0);
        let injectObjectTypeMismatch = false;
        vi.spyOn(fixture.store.git, "run").mockImplementation(async (args, options) => {
            if (args[0] === "diff-tree") return { stdout: injected, stderr: Buffer.alloc(0) };
            if (injectObjectTypeMismatch && args[0] === "cat-file" && args[1]?.startsWith("--batch-check=")) {
                return {
                    stdout: Buffer.from(`${beforeState.oid} tree\n${afterState.oid} blob\n`),
                    stderr: Buffer.alloc(0),
                };
            }
            return await originalRun(args, options);
        });

        const malformed = [
            ["odd record count", Buffer.concat([Buffer.from(validHeader), Buffer.from([0])])],
            ["truncated path", record(validHeader).subarray(0, -1)],
            ["unknown status", record(`${validHeader.slice(0, -1)}Q`)],
            ["A with a present base", record(`${validHeader.slice(0, -1)}A`)],
            ["D with a present result", record(`${validHeader.slice(0, -1)}D`)],
            ["M with a zero base", record(`:100644 100644 ${zeroOid} ${afterState.oid} M`)],
            ["T without a type change", record(`${validHeader.slice(0, -1)}T`)],
            ["duplicate path", Buffer.concat([record(validHeader), record(validHeader)])],
            ["invalid UTF-8 path", record(validHeader, Buffer.from([0xff]))],
            ["invalid mode", record(`:100600 100644 ${beforeState.oid} ${afterState.oid} M`)],
        ] as const;
        for (const [_label, output] of malformed) {
            injected = output;
            await expect(fixture.store.diff(before.ref, after.ref)).rejects.toThrow(/tree delta|status|UTF-8/i);
        }

        injected = record(validHeader);
        injectObjectTypeMismatch = true;
        await expect(fixture.store.diff(before.ref, after.ref)).rejects.toThrow(/object|blob|snapshot/i);

        injectObjectTypeMismatch = false;
        injected = record(
            `:100644 100644 ${"a".repeat(beforeState.oid.length)} ${"b".repeat(beforeState.oid.length)} M`
        );
        await expect(fixture.store.diff(before.ref, after.ref)).rejects.toThrow(/object|blob|snapshot/i);
    });

    it("keeps trusted hot paths candidate-bound and recursively audits a cold V3 ref only once", async () => {
        const fixture = await makeFixture();
        for (let index = 0; index < 2; index++) {
            await mkdir(join(fixture.workspace, `dir-${index}`));
            await writeFile(join(fixture.workspace, `dir-${index}`, "file.txt"), `value-${index}`);
        }
        const captured = await fixture.store.captureFullReconcile({ profile: "terminal" });
        const commit = await appendMutation(fixture, captured.tree);
        const run = vi.spyOn(fixture.store.git, "run");

        const ref = await fixture.store.publishCommitSnapshot({ commit, ...captured });
        expect(countTreeReads(run.mock.calls)).toBe(0);
        run.mockClear();
        await fixture.store.verifyOwnedSnapshot(ref);
        await fixture.store.verifyOwnedSnapshot(ref);
        expect(countTreeReads(run.mock.calls)).toBe(0);

        const coldStore = await WorkspaceSnapshotStore.open({
            dataRoot: fixture.dataRoot,
            identity: fixture.identity,
            git: fixture.git,
            processOwner: fixture.processOwner,
        });
        const coldRef = await coldStore.readCommitSnapshot(commit);
        const coldRun = vi.spyOn(coldStore.git, "run");
        await coldStore.verifyOwnedSnapshot(coldRef);
        expect(countTreeReads(coldRun.mock.calls)).toBeGreaterThanOrEqual(3);
        coldRun.mockClear();
        await coldStore.verifyOwnedSnapshot(coldRef);
        expect(countTreeReads(coldRun.mock.calls)).toBe(0);
    });

    it("fails closed for conflicting, malformed, and symbolic V3 associations", async () => {
        const fixture = await makeFixture();
        const captured = await fixture.store.captureFullReconcile({ profile: "terminal" });
        const commit = await appendMutation(fixture, captured.tree);
        const ref = await fixture.store.publishCommitSnapshot({ commit, ...captured });

        await expect(
            fixture.store.publishCommitSnapshot({
                commit,
                scope: captured.scope,
                coverage: {
                    ...captured.coverage,
                    complete: false,
                    exclusions: [{ path: "ignored", reason: "ignored" }],
                },
            })
        ).rejects.toThrow(/association|manifest/i);

        const malformed = await writeBlob(
            fixture,
            Buffer.from(
                JSON.stringify(JSON.parse((await fixture.store.readBlob(ref.scopeManifest)).toString("utf8")), null, 2)
            )
        );
        const association = fixture.store.ownerRefName(commit);
        await fixture.git.run(["update-ref", "--no-deref", association, malformed, ref.scopeManifest], {
            gitDir: fixture.store.storeRoot,
            timeoutMs: 5_000,
        });
        await expect(fixture.store.readCommitSnapshot(commit)).rejects.toThrow(/canonical/i);

        await fixture.git.run(["update-ref", "-d", association, malformed], {
            gitDir: fixture.store.storeRoot,
            timeoutMs: 5_000,
        });
        const target = "refs/crest/ops/symbolic-manifest";
        await fixture.git.run(["update-ref", target, ref.scopeManifest], {
            gitDir: fixture.store.storeRoot,
            timeoutMs: 5_000,
        });
        const associationPath = join(fixture.store.storeRoot, association);
        await mkdir(dirname(associationPath), { recursive: true });
        await writeFile(associationPath, `ref: ${target}\n`);
        await expect(fixture.store.readCommitSnapshot(commit)).rejects.toThrow(/symbolic/i);

        await rm(associationPath);
        await symlink(join(fixture.store.storeRoot, target), associationPath);
        await expect(fixture.store.readCommitSnapshot(commit)).rejects.toThrow(/symbolic|symlink|unsafe/i);
    });

    it("recursively audits V3 eligible counts and coverage completeness", async () => {
        const fixture = await makeFixture();
        const captured = await fixture.store.captureFullReconcile({ profile: "terminal" });
        const wrongCountCommit = await appendMutation(fixture, captured.tree);
        const wrongCount = await fixture.store.publishCommitSnapshot({
            commit: wrongCountCommit,
            scope: captured.scope,
            coverage: { ...captured.coverage, eligibleEntryCount: captured.coverage.eligibleEntryCount + 1 },
        });
        await expect(fixture.store.verify(wrongCount)).rejects.toThrow(/coverage|eligible/i);

        const nextCommit = await appendMutation(fixture, captured.tree, wrongCountCommit, "coverage-shape");
        expect(() =>
            fixture.store.publishCommitSnapshot({
                commit: nextCommit,
                scope: captured.scope,
                coverage: {
                    complete: true,
                    eligibleEntryCount: captured.coverage.eligibleEntryCount,
                    exclusions: [{ path: "ignored", reason: "ignored" }],
                },
            })
        ).toThrow(/coverage|complete/i);
    });

    it("rejects unsorted, invalid-mode, and non-UTF8 raw V3 trees", async () => {
        const fixture = await makeFixture();
        const blob = await writeBlob(fixture, Buffer.from("value"));
        const scope = (await fixture.store.captureFullReconcile({ profile: "terminal" })).scope;
        const cases = [
            Buffer.concat([
                rawTreeEntry("100644", Buffer.from("z.txt"), blob),
                rawTreeEntry("100644", Buffer.from("a.txt"), blob),
            ]),
            Buffer.concat([
                Buffer.from([0xb1, 0xb0, 0xb0, 0xb6, 0xb4, 0xb4, 0x20]),
                Buffer.from("mode.txt\0"),
                Buffer.from(blob, "hex"),
            ]),
            rawTreeEntry("100644", Buffer.from([0xff]), blob),
        ];
        let parent: string | undefined;
        for (let index = 0; index < cases.length; index++) {
            const tree = await writeRawTree(fixture, cases[index]!);
            const commit = await appendMutation(fixture, tree, parent, `raw-${index}`);
            parent = commit;
            const ref = await fixture.store.publishCommitSnapshot({
                commit,
                scope,
                coverage: { complete: true, eligibleEntryCount: index === 0 ? 2 : 1, exclusions: [] },
            });
            await expect(fixture.store.verify(ref)).rejects.toThrow(/tree|order|mode|utf|path/i);
        }
    });

    it("rejects a missing V3 blob and a branch that points to a blob", async () => {
        const fixture = await makeFixture();
        const scope = (await fixture.store.captureFullReconcile({ profile: "terminal" })).scope;
        const missingTree = await writeRawTree(
            fixture,
            rawTreeEntry("100644", Buffer.from("missing.txt"), "f".repeat(40))
        );
        const missingCommit = await appendMutation(fixture, missingTree, undefined, "missing-blob");
        const missing = await fixture.store.publishCommitSnapshot({
            commit: missingCommit,
            scope,
            coverage: { complete: true, eligibleEntryCount: 1, exclusions: [] },
        });
        await expect(fixture.store.verify(missing)).rejects.toThrow(/missing|blob|object/i);

        const blob = await writeBlob(fixture, Buffer.from("not a tree"));
        const branchTree = await writeRawTree(fixture, rawTreeEntry("40000", Buffer.from("branch"), blob));
        const branchCommit = await appendMutation(fixture, branchTree, missingCommit, "blob-branch");
        const branch = await fixture.store.publishCommitSnapshot({
            commit: branchCommit,
            scope,
            coverage: { complete: true, eligibleEntryCount: 1, exclusions: [] },
        });
        await expect(fixture.store.verify(branch)).rejects.toMatchObject({ code: "corrupt_snapshot" });
    });

    it("keeps V3 metadata reachable through GC and includes it in usage traversal", async () => {
        const fixture = await makeFixture();
        const captured = await fixture.store.captureFullReconcile({ profile: "terminal" });
        const commit = await appendMutation(fixture, captured.tree);
        const ref = await fixture.store.publishCommitSnapshot({ commit, ...captured });

        await expect(fixture.store.measureSnapshotUsage([ref])).resolves.toBeGreaterThan(0);
        await fixture.git.run(["reflog", "expire", "--expire=now", "--all"], {
            gitDir: fixture.store.storeRoot,
            timeoutMs: 5_000,
        });
        await fixture.git.run(["gc", "--prune=now"], { gitDir: fixture.store.storeRoot, timeoutMs: 30_000 });

        await expect(fixture.store.readCommitSnapshot(commit)).resolves.toEqual(ref);
        await expect(fixture.store.readBlob(ref.scopeManifest)).resolves.toBeInstanceOf(Buffer);
        await expect(fixture.store.verifyOwnedSnapshot(ref)).resolves.toBeUndefined();
    });

    it("publishes the object anchor and manifest association in one ref transaction", async () => {
        const fixture = await makeFixture();
        const captured = await fixture.store.captureFullReconcile({ profile: "terminal" });
        const commit = await appendMutation(fixture, captured.tree);
        const run = vi.spyOn(fixture.store.git, "run");

        const ref = await fixture.store.publishCommitSnapshot({ commit, ...captured });

        const transactions = run.mock.calls.filter(
            ([args]) =>
                Array.isArray(args) && args[0] === "update-ref" && args[1] === "--no-deref" && args[2] === "--stdin"
        );
        expect(transactions).toHaveLength(1);
        const options = transactions[0]?.[1];
        expect(options).toMatchObject({ stdin: expect.any(Buffer) });
        expect((options as { stdin: Buffer }).stdin.toString("utf8")).toBe(
            [
                "start",
                `update ${fixture.store.snapshotObjectRefName(commit)} ${commit} ${"0".repeat(commit.length)}`,
                `update ${fixture.store.ownerRefName(commit)} ${ref.scopeManifest} ${"0".repeat(ref.scopeManifest.length)}`,
                "prepare",
                "commit",
                "",
            ].join("\n")
        );
    });

    it("leaves both snapshot refs unpublished when their publication transaction fails", async () => {
        const fixture = await makeFixture();
        const captured = await fixture.store.captureFullReconcile({ profile: "terminal" });
        const commit = await appendMutation(fixture, captured.tree);
        const objectRef = fixture.store.snapshotObjectRefName(commit);
        const ownerRef = fixture.store.ownerRefName(commit);
        const originalRun = fixture.store.git.run.bind(fixture.store.git);
        const run = vi.spyOn(fixture.store.git, "run").mockImplementation(async (args, options) => {
            const isAtomicPublication = args[0] === "update-ref" && args[1] === "--no-deref" && args[2] === "--stdin";
            const isLegacySecondWrite = args[0] === "update-ref" && args[2] === ownerRef;
            if (isAtomicPublication || isLegacySecondWrite) {
                throw new Error("injected snapshot ref publication failure");
            }
            return await originalRun(args, options);
        });

        await expect(fixture.store.publishCommitSnapshot({ commit, ...captured })).rejects.toThrow(/injected/i);
        run.mockRestore();

        await expect(readRef(fixture, objectRef)).resolves.toBeUndefined();
        await expect(readRef(fixture, ownerRef)).resolves.toBeUndefined();
    });

    it("counts objects reachable only from snapshot object anchors toward referenced quota", async () => {
        const fixture = await makeFixture();
        const bytes = Buffer.from("object-anchor-only");
        const oid = await writeBlob(fixture, bytes);
        await fixture.git.run(["update-ref", `refs/crest-objects/snapshots/${"a".repeat(40)}`, oid], {
            gitDir: fixture.store.storeRoot,
            timeoutMs: 5_000,
        });

        await expect(fixture.store.getQuotaStatus()).resolves.toMatchObject({ referencedBytes: bytes.length });
    });
});

describe("private V3 bare-store bootstrap safety", () => {
    it("initializes and repairs a private bare repository without index or alternates", async () => {
        const root = await temporaryBootstrapRoot("bare");
        const storeRoot = join(root, "repo.git");
        const input = {
            storeRoot,
            git: new WorkspaceGitRunner(),
            processOwner: await makeProcessOwnerIdentity(),
        };

        await initializePrivateStore(input);
        await chmod(storeRoot, 0o755);
        await chmod(join(storeRoot, "objects"), 0o755);
        await initializePrivateStore(input);

        expect((await stat(storeRoot)).mode & 0o777).toBe(0o700);
        expect((await stat(join(storeRoot, "objects"))).mode & 0o777).toBe(0o700);
        expect((await stat(join(storeRoot, "refs"))).mode & 0o777).toBe(0o700);
        expect((await stat(join(storeRoot, "journal"))).mode & 0o777).toBe(0o700);
        await expect(lstat(join(storeRoot, "index"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(join(storeRoot, "objects", "info", "alternates"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(join(storeRoot, "config"), "utf8")).toMatch(/bare = true/);
    });

    it("repairs an interrupted bare repository bootstrap", async () => {
        const root = await temporaryBootstrapRoot("interrupted");
        const storeRoot = join(root, "repo.git");
        await mkdir(storeRoot);

        await initializePrivateStore({
            storeRoot,
            git: new WorkspaceGitRunner(),
            processOwner: await makeProcessOwnerIdentity(),
        });

        expect((await stat(join(storeRoot, "objects"))).isDirectory()).toBe(true);
        expect((await stat(join(storeRoot, "refs"))).isDirectory()).toBe(true);
    });

    it("recovers dead owner and candidate records left by a bootstrap crash", async () => {
        const root = await temporaryBootstrapRoot("crash");
        const storeRoot = join(root, "repo.git");
        const ownerPath = join(root, ".bootstrap-owner");
        const candidatePath = join(root, `.bootstrap-owner.candidate-${2 ** 30}-${"a".repeat(24)}`);
        const deadOwner = JSON.stringify({
            pid: 2 ** 30,
            processstarttoken: "dead",
            nonce: "b".repeat(64),
        });
        await writeFile(ownerPath, deadOwner, { mode: 0o666 });
        await writeFile(candidatePath, deadOwner, { mode: 0o666 });

        await initializePrivateStore({
            storeRoot,
            git: new WorkspaceGitRunner(),
            processOwner: await makeProcessOwnerIdentity(),
        });

        await expect(lstat(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(lstat(candidatePath)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await stat(storeRoot)).isDirectory()).toBe(true);
    });

    it("repairs every repository directory and file to owner-only permissions", async () => {
        const root = await temporaryBootstrapRoot("permissions");
        const storeRoot = join(root, "repo.git");
        const input = {
            storeRoot,
            git: new WorkspaceGitRunner(),
            processOwner: await makeProcessOwnerIdentity(),
        };
        await initializePrivateStore(input);
        await chmod(join(storeRoot, "hooks"), 0o755);
        await chmod(join(storeRoot, "hooks", "applypatch-msg.sample"), 0o644);

        await initializePrivateStore(input);

        await expectOwnerOnlyTree(storeRoot);
    });

    it("fails closed when the store root is redirected through a symlink", async () => {
        const root = await temporaryBootstrapRoot("symlink");
        const outside = join(root, "outside");
        const storeRoot = join(root, "repo.git");
        await mkdir(outside);
        await symlink(outside, storeRoot);

        await expect(
            initializePrivateStore({
                storeRoot,
                git: new WorkspaceGitRunner(),
                processOwner: await makeProcessOwnerIdentity(),
            })
        ).rejects.toThrow(/unsafe snapshot store/i);
        expect(await readdir(outside)).toEqual([]);
    });
});

async function makeFixture() {
    const root = await mkdtemp(join(tmpdir(), "crest-snapshot-store-v3-"));
    TemporaryRoots.push(root);
    process.env.WAVETERM_DATA_HOME = join(root, "data-home");
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, "cache"), { recursive: true });
    await writeFile(join(workspace, ".gitignore"), "cache\n");
    await writeFile(join(workspace, "plain.txt"), "before");
    await writeFile(join(workspace, "tool.sh"), "#!/bin/sh\nexit 0\n");
    await symlink("plain.txt", join(workspace, "link"));
    await writeFile(join(workspace, "cache", "ignored.txt"), "ignored");

    const git = new WorkspaceGitRunner();
    const identity = await resolveCanonicalWorkspaceIdentity(workspace);
    const processOwner = {
        pid: process.pid,
        processStartToken: "snapshot-store-v3",
        nonce: "e".repeat(64),
    };
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: join(root, "data"),
        identity,
        git,
        processOwner,
    });
    return { root, workspace, store, dataRoot: join(root, "data"), identity, git, processOwner };
}

async function makeHundredChangedCandidates() {
    const fixture = await makeFixture();
    const paths = Array.from({ length: 100 }, (_, index) => `candidate-${index}`);
    await Promise.all(paths.map((path) => writeFile(join(fixture.workspace, path), "before")));
    const before = await fixture.store.capture({ profile: "terminal" });
    await Promise.all(paths.map((path) => writeFile(join(fixture.workspace, path), "after")));
    const after = await fixture.store.capture({ profile: "terminal" });
    const state = await fixture.store.readPathState(after.ref, paths[0]!);
    if (state.state !== "file") throw new Error("expected a captured candidate file");
    const candidates = paths.map((path) => ({
        path,
        state: { state: "file" as const, oid: state.oid, executable: false },
    }));
    return { fixture, before, after, paths, candidates };
}

function compareTestPaths(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

async function appendMutation(
    fixture: Awaited<ReturnType<typeof makeFixture>>,
    tree: string,
    expectedHead?: string,
    turnId = "v3-safety"
): Promise<string> {
    return await fixture.store.mutationLog.append({
        ...(expectedHead ? { expectedHead } : {}),
        tree,
        metadata: {
            schemaversion: 1,
            workspaceidentity: fixture.identity.workspaceIdentity,
            workspaceincarnation: fixture.identity.workspaceIncarnation,
            kind: "agent-turn",
            sessionid: "v3-safety-session",
            turnid: turnId,
        },
    });
}

async function writeBlob(fixture: Awaited<ReturnType<typeof makeFixture>>, bytes: Buffer): Promise<string> {
    const result = await fixture.git.run(["hash-object", "-w", "--stdin", "--no-filters"], {
        gitDir: fixture.store.storeRoot,
        stdin: bytes,
        timeoutMs: 5_000,
    });
    return result.stdout.toString("ascii").trim();
}

async function readRef(fixture: Awaited<ReturnType<typeof makeFixture>>, refName: string): Promise<string | undefined> {
    const result = await fixture.git.run(["for-each-ref", "--format=%(objectname)", refName], {
        gitDir: fixture.store.storeRoot,
        timeoutMs: 5_000,
    });
    const oid = result.stdout.toString("ascii").trim();
    return oid || undefined;
}

async function writeRawTree(fixture: Awaited<ReturnType<typeof makeFixture>>, bytes: Buffer): Promise<string> {
    const result = await fixture.git.run(["hash-object", "-t", "tree", "-w", "--stdin", "--literally"], {
        gitDir: fixture.store.storeRoot,
        stdin: bytes,
        timeoutMs: 5_000,
    });
    return result.stdout.toString("ascii").trim();
}

function rawTreeEntry(mode: string, name: Buffer, oid: string): Buffer {
    return Buffer.concat([Buffer.from(`${mode} `), name, Buffer.from([0]), Buffer.from(oid, "hex")]);
}

function countTreeReads(calls: readonly (readonly unknown[])[]): number {
    return calls.filter((call) => {
        const args = call[0];
        return Array.isArray(args) && args[0] === "cat-file" && args[1] === "tree";
    }).length;
}

async function temporaryBootstrapRoot(label: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `crest-v3-bootstrap-${label}-`));
    TemporaryRoots.push(root);
    return root;
}

async function expectOwnerOnlyTree(root: string): Promise<void> {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
        const path = join(root, entry.name);
        const value = await lstat(path);
        if (entry.isDirectory()) {
            expect(value.mode & 0o777, path).toBe(0o700);
            await expectOwnerOnlyTree(path);
            continue;
        }
        expect(entry.isSymbolicLink(), path).toBe(false);
        expect(value.mode & 0o777, path).toBe(0o600);
    }
}
