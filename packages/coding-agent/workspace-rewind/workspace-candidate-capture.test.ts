// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import { materializeWorkspaceCandidateBatch, WorkspaceCandidateCapture } from "./workspace-candidate-capture";
import { resolveCanonicalWorkspaceIdentity } from "./workspace-identity";
import { discoverWorkspaceScope } from "./workspace-scope";

const TemporaryRoots: string[] = [];
const OriginalDataHome = process.env.WAVETERM_DATA_HOME;

afterEach(async () => {
    if (OriginalDataHome == null) delete process.env.WAVETERM_DATA_HOME;
    else process.env.WAVETERM_DATA_HOME = OriginalDataHome;
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
    const capture = new WorkspaceCandidateCapture({
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
    });
    return { capture, store, workspace };
}

function gitBlobOid(bytes: Buffer): string {
    return createHash("sha1")
        .update(Buffer.from(`blob ${bytes.length}\0`))
        .update(bytes)
        .digest("hex");
}
