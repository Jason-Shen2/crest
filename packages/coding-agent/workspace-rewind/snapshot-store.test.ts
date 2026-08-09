// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import { WorkspaceSnapshotStore } from "./snapshot-store";
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
        await symlink("plain.txt", join(fixture.workspace, "new-link"));
        const after = await fixture.store.capture({ profile: "terminal" });

        expect((await fixture.store.diff(before.ref, after.ref)).map((change) => change.path)).toEqual([
            "link",
            "new-link",
            "plain.txt",
            "tool.sh",
        ]);
        expect(await fixture.store.readPathState(after.ref, "tool.sh")).toMatchObject({
            state: "file",
            executable: true,
        });
        expect(await readFile(join(fixture.workspace, "plain.txt"))).toEqual(Buffer.from("after\r\n"));
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
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: join(root, "data"),
        identity,
        git,
        processOwner: { pid: process.pid, processStartToken: "snapshot-store-v3", nonce: "e".repeat(64) },
    });
    return { root, workspace, store };
}
