// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import { materializeWorkspaceCandidateBatch, WorkspaceCandidateCapture } from "./workspace-candidate-capture";
import { resolveCanonicalWorkspaceIdentity } from "./workspace-identity";
import { discoverWorkspaceScope } from "./workspace-scope";

const TemporaryRoots: string[] = [];
const CandidateCaptures: WorkspaceCandidateCapture[] = [];
const OriginalDataHome = process.env.WAVETERM_DATA_HOME;
const OriginalTmpDir = process.env.TMPDIR;

afterEach(async () => {
    if (OriginalDataHome == null) delete process.env.WAVETERM_DATA_HOME;
    else process.env.WAVETERM_DATA_HOME = OriginalDataHome;
    if (OriginalTmpDir == null) delete process.env.TMPDIR;
    else process.env.TMPDIR = OriginalTmpDir;
    await Promise.allSettled(CandidateCaptures.splice(0).map((capture) => capture.dispose()));
    await Promise.all(TemporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceCandidateCapture", () => {
    it("captures stable raw file, executable, symlink, binary, and absent path states before materialization", async () => {
        const fixture = await makeFixture();
        await writeFile(join(fixture.workspace, "plain.txt"), "after\r\n");
        await writeFile(join(fixture.workspace, "tool.sh"), "#!/bin/sh\nprintf raw");
        await chmod(join(fixture.workspace, "tool.sh"), 0o755);
        await writeFile(join(fixture.workspace, "binary.bin"), Buffer.from([0, 255, 1, 254]));
        await rm(join(fixture.workspace, "deleted.txt"));

        const result = await fixture.capture.capture(["tool.sh", "plain.txt", "link", "deleted.txt", "binary.bin"]);

        expect(result).toMatchObject({
            status: "captured",
            entries: [
                { path: "binary.bin", state: { state: "file", executable: false } },
                { path: "deleted.txt", state: { state: "absent" } },
                { path: "link", state: { state: "symlink" } },
                { path: "plain.txt", state: { state: "file", executable: false } },
                { path: "tool.sh", state: { state: "file", executable: true } },
            ],
            newlyHashedBytes: 4 + 6 + 7 + 20,
        });
        if (result.status !== "captured") throw new Error("expected captured candidates");

        const materialized = new Map<string, Buffer>();
        await fixture.capture.consumeCaptured(result, async (batch) => {
            await materializeWorkspaceCandidateBatch(batch, {
                storeRoot: fixture.store.storeRoot,
                writeBlob: async (bytes) => {
                    const oid = gitBlobOid(bytes);
                    materialized.set(oid, Buffer.from(bytes));
                    return oid;
                },
            });
        });

        for (const entry of result.entries) {
            if (entry.state.state === "file" || entry.state.state === "symlink") {
                expect(materialized.get(entry.state.oid)).toBeDefined();
            }
        }
        expect([...materialized.values()]).toEqual(
            expect.arrayContaining([
                Buffer.from([0, 255, 1, 254]),
                Buffer.from("target"),
                Buffer.from("after\r\n"),
                Buffer.from("#!/bin/sh\nprintf raw"),
            ])
        );
        await expect(fixture.capture.discardCaptured(result)).rejects.toThrow(/consumed|pending/i);
        await fixture.capture.dispose();
    });

    it("fails closed for unsafe evidence and preserves abort and byte-budget outcomes", async () => {
        const fixture = await makeFixture(1);
        await writeFile(join(fixture.workspace, "plain.txt"), "larger");

        await expect(fixture.capture.capture(["plain.txt"])).resolves.toEqual({
            status: "reconcile",
            reason: "unsafe-evidence",
        });

        const controller = new AbortController();
        const reason = new Error("stop candidate capture");
        controller.abort(reason);
        await expect(fixture.capture.capture([], controller.signal)).rejects.toBe(reason);
        await fixture.capture.dispose();
    });

    it("gives one concurrent consume or discard operation exclusive ownership", async () => {
        const fixture = await makeFixture();
        await writeFile(join(fixture.workspace, "plain.txt"), "changed");
        const result = await fixture.capture.capture(["plain.txt"]);
        const consumerGate = deferred();
        const consumerStarted = deferred();
        const consuming = fixture.capture.consumeCaptured(result, async () => {
            consumerStarted.resolve();
            await consumerGate.promise;
        });
        await consumerStarted.promise;

        await expect(fixture.capture.discardCaptured(result)).rejects.toThrow(/operation.*active/i);
        consumerGate.resolve();
        await consuming;

        const second = await fixture.capture.capture([]);
        const discards = await Promise.allSettled([
            fixture.capture.discardCaptured(second),
            fixture.capture.discardCaptured(second),
        ]);
        expect(discards.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
        expect(discards.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    });

    it("waits for an active consumer before dispose cleans the captured batch", async () => {
        const fixture = await makeFixture();
        await writeFile(join(fixture.workspace, "plain.txt"), "changed");
        const result = await fixture.capture.capture(["plain.txt"]);
        const consumerGate = deferred();
        const consumerStarted = deferred();
        const consuming = fixture.capture.consumeCaptured(result, async () => {
            consumerStarted.resolve();
            await consumerGate.promise;
        });
        await consumerStarted.promise;
        let disposed = false;
        const disposing = fixture.capture.dispose().then(() => {
            disposed = true;
        });
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(disposed).toBe(false);
        consumerGate.resolve();
        await Promise.all([consuming, disposing]);
        expect(disposed).toBe(true);
    });

    it("dispose aborts and drains an in-flight capture without late registration", async () => {
        const fixture = await makeFixture();
        const started = deferred();
        let captureSettled = false;
        vi.spyOn(fixture.capture, "captureActive").mockImplementation(
            async (_paths, signal) =>
                await new Promise((_, reject) => {
                    started.resolve();
                    signal.addEventListener(
                        "abort",
                        () => {
                            setImmediate(() => {
                                captureSettled = true;
                                reject(signal.reason);
                            });
                        },
                        { once: true }
                    );
                })
        );
        const pending = fixture.capture.capture(["plain.txt"]);
        await started.promise;

        await fixture.capture.dispose();

        await expect(pending).rejects.toThrow(/disposed/i);
        expect(captureSettled).toBe(true);
        expect(fixture.capture.pendingBatches.size).toBe(0);
        await expect(fixture.capture.capture([])).rejects.toThrow(/disposed/i);
    });

    it("preserves consumer and cleanup failures and retries cleanup without re-consuming", async () => {
        const fixture = await makeFixture();
        await writeFile(join(fixture.workspace, "plain.txt"), "changed");
        const result = await fixture.capture.capture(["plain.txt"]);
        const consumerError = new Error("consumer failed");
        const cleanupError = new Error("cleanup failed");
        const originalCleanup = fixture.capture.cleanupPendingBatch.bind(fixture.capture);
        vi.spyOn(fixture.capture, "cleanupPendingBatch")
            .mockRejectedValueOnce(cleanupError)
            .mockImplementation(originalCleanup);

        let failure: unknown;
        try {
            await fixture.capture.consumeCaptured(result, async () => {
                throw consumerError;
            });
        } catch (error) {
            failure = error;
        }

        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toEqual([consumerError, cleanupError]);
        await expect(fixture.capture.consumeCaptured(result, async () => undefined)).rejects.toThrow(/consumed/i);
        await expect(fixture.capture.discardCaptured(result)).resolves.toBeUndefined();
    });

    it("retains failed cleanup ownership for a later dispose retry", async () => {
        const fixture = await makeFixture();
        await writeFile(join(fixture.workspace, "plain.txt"), "changed");
        await fixture.capture.capture(["plain.txt"]);
        const originalCleanup = fixture.capture.cleanupPendingBatch.bind(fixture.capture);
        vi.spyOn(fixture.capture, "cleanupPendingBatch")
            .mockRejectedValueOnce(new Error("dispose cleanup failed"))
            .mockImplementation(originalCleanup);

        await expect(fixture.capture.dispose()).rejects.toBeInstanceOf(AggregateError);
        expect(fixture.capture.pendingBatches.size).toBe(1);
        await expect(fixture.capture.dispose()).resolves.toBeUndefined();
        expect(fixture.capture.pendingBatches.size).toBe(0);
    });

    it("cleans abandoned staging and invalidates every pending result", async () => {
        const fixture = await makeFixture();
        const stagingParent = join(fixture.root, "candidate-staging");
        await mkdir(stagingParent);
        process.env.TMPDIR = stagingParent;
        await writeFile(join(fixture.workspace, "plain.txt"), "changed");
        const first = await fixture.capture.capture(["plain.txt"]);
        const second = await fixture.capture.capture([]);
        const staging = (await readdir(stagingParent)).filter((name) =>
            name.startsWith("crest-workspace-candidate-capture-")
        );
        expect(staging).toHaveLength(1);

        await fixture.capture.dispose();

        await expect(stat(join(stagingParent, staging[0]!))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fixture.capture.discardCaptured(first)).rejects.toThrow(/pending|discarded|consumed/i);
        await expect(fixture.capture.discardCaptured(second)).rejects.toThrow(/pending|discarded|consumed/i);
    });

    it("registers no batch after caller abort or deadline expiry", async () => {
        const fixture = await makeFixture();
        const controller = new AbortController();
        const abortReason = new Error("caller aborted");
        controller.abort(abortReason);

        await expect(fixture.capture.capture([], controller.signal)).rejects.toBe(abortReason);
        expect(fixture.capture.pendingBatches.size).toBe(0);

        const expired = new WorkspaceCandidateCapture({ ...fixture.options, timeoutMs: 0 });
        CandidateCaptures.push(expired);
        await expect(expired.capture([])).rejects.toMatchObject({ code: "timeout" });
        expect(expired.pendingBatches.size).toBe(0);
    });
});

async function makeFixture(maxNewlyHashedBytes = 1024 ** 2) {
    const root = await mkdtemp(join(tmpdir(), "crest-workspace-candidate-capture-"));
    TemporaryRoots.push(root);
    process.env.WAVETERM_DATA_HOME = join(root, "data-home");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "plain.txt"), "before");
    await writeFile(join(workspace, "tool.sh"), "before");
    await writeFile(join(workspace, "binary.bin"), "before");
    await writeFile(join(workspace, "deleted.txt"), "before");
    await symlink("target", join(workspace, "link"));
    const git = new WorkspaceGitRunner();
    const identity = await resolveCanonicalWorkspaceIdentity(workspace);
    const scope = await discoverWorkspaceScope({
        identity,
        git,
        maxEntries: 10_000,
        maxUntrackedBytes: 2 * 1024 ** 2,
    });
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: join(root, "data"),
        identity,
        git,
        processOwner: { pid: process.pid, processStartToken: "candidate-capture-test", nonce: "f".repeat(64) },
    });
    const options = {
        identity,
        git,
        storeRoot: store.storeRoot,
        scope: scope.manifest,
        maxEntries: 10_000,
        maxUntrackedBytes: 2 * 1024 ** 2,
        maxNewlyHashedBytes,
        timeoutMs: 10_000,
        base: {
            readNodeKind: async (path) => (scope.entries.some((entry) => entry.path === path) ? "leaf" : "absent"),
        },
    };
    const capture = new WorkspaceCandidateCapture(options);
    CandidateCaptures.push(capture);
    return { capture, options, root, store, workspace };
}

function gitBlobOid(bytes: Buffer): string {
    return createHash("sha1")
        .update(Buffer.from(`blob ${bytes.length}\0`))
        .update(bytes)
        .digest("hex");
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
