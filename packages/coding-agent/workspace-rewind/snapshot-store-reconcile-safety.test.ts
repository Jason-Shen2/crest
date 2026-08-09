// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { ReconciledWorkspaceState } from "./snapshot-store";
import { resolveCanonicalWorkspaceIdentity } from "./workspace-identity";

const CleanupRoots: string[] = [];

afterEach(async () => {
    vi.doUnmock("node:fs/promises");
    vi.doUnmock("./workspace-identity");
    vi.doUnmock("./workspace-path-reader");
    vi.doUnmock("./workspace-scope");
    vi.resetModules();
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native V3 full reconcile safety", () => {
    test("rejects a canonical-root replacement before returning a raw tree", async () => {
        let workspace = "";
        let checks = 0;
        vi.doMock("./workspace-identity", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-identity")>();
            return {
                ...actual,
                verifyCanonicalWorkspaceIdentity: async (
                    identity: Parameters<typeof actual.verifyCanonicalWorkspaceIdentity>[0]
                ) => {
                    checks++;
                    if (checks === 2) {
                        await rename(workspace, `${workspace}-moved`);
                        await mkdir(workspace);
                    }
                    return await actual.verifyCanonicalWorkspaceIdentity(identity);
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./snapshot-store");
        const fixture = await makeFixture(isolated.WorkspaceSnapshotStore, "root-replacement");
        workspace = fixture.workspace;
        await writeFile(join(workspace, "tracked.txt"), "tracked");

        await expect(fixture.store.captureFullReconcile({ profile: "terminal" })).rejects.toThrow(/identity chain/i);
        expect(checks).toBe(2);
    });

    test("retries one directory race and includes the stable second attempt", async () => {
        let workspace = "";
        let checks = 0;
        vi.doMock("./workspace-scope", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-scope")>();
            return {
                ...actual,
                verifyWorkspaceScopeDirectories: async (
                    scope: Parameters<typeof actual.verifyWorkspaceScopeDirectories>[0],
                    signal?: AbortSignal
                ) => {
                    checks++;
                    if (checks === 1) {
                        await writeFile(join(workspace, "appeared.txt"), "appeared");
                        return false;
                    }
                    return await actual.verifyWorkspaceScopeDirectories(scope, signal);
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./snapshot-store");
        const fixture = await makeFixture(isolated.WorkspaceSnapshotStore, "directory-retry");
        workspace = fixture.workspace;

        const captured = await fixture.store.captureFullReconcile({ profile: "terminal" });
        const commit = await publishCaptured(fixture, captured, "directory-retry");

        expect(checks).toBe(2);
        await expect(fixture.store.readPathState(commit, "appeared.txt")).resolves.toMatchObject({ state: "file" });
    });

    test("fails after exactly two directory-race attempts", async () => {
        let checks = 0;
        vi.doMock("./workspace-scope", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-scope")>();
            return { ...actual, verifyWorkspaceScopeDirectories: async () => (++checks, false) };
        });
        vi.resetModules();
        const isolated = await import("./snapshot-store");
        const fixture = await makeFixture(isolated.WorkspaceSnapshotStore, "directory-failure");

        await expect(fixture.store.captureFullReconcile({ profile: "terminal" })).rejects.toMatchObject({
            code: "unstable_file",
        });
        expect(checks).toBe(2);
    });

    test("shares one newly-hashed byte budget across whole reconcile attempts", async () => {
        const attemptedBytes = Math.floor(1024 ** 3 / 2) + 1;
        let readerCalls = 0;
        let directoryChecks = 0;
        vi.doMock("./workspace-scope", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-scope")>();
            return {
                ...actual,
                verifyWorkspaceScopeDirectories: async () => ++directoryChecks !== 1,
            };
        });
        vi.doMock("./workspace-path-reader", async (importOriginal) => {
            const actual = await importOriginal<typeof import("./workspace-path-reader")>();
            return {
                ...actual,
                runStablePathReader: async (input: Parameters<typeof actual.runStablePathReader>[0]) => {
                    readerCalls++;
                    if (attemptedBytes > input.maxTotalBytes) {
                        throw new actual.StablePathReaderError("capture_budget", "shared byte budget exhausted");
                    }
                    await Promise.all(input.entries.map((entry) => writeFile(entry.stagingPath, "x")));
                    return input.entries.map((entry) => ({
                        path: entry.path,
                        stagingPath: entry.stagingPath,
                        identity: entry.identity,
                        hashedBytes: attemptedBytes,
                    }));
                },
            };
        });
        vi.resetModules();
        const isolated = await import("./snapshot-store");
        const fixture = await makeFixture(isolated.WorkspaceSnapshotStore, "shared-budget");
        await writeFile(join(fixture.workspace, "target.txt"), "target");

        await expect(fixture.store.captureFullReconcile({ profile: "terminal" })).rejects.toMatchObject({
            code: "capture_budget",
        });
        expect(readerCalls).toBe(2);
        expect(directoryChecks).toBe(1);
    });

    test("stops an already-aborted reconcile before Git or quota work", async () => {
        const isolated = await import("./snapshot-store");
        const fixture = await makeFixture(isolated.WorkspaceSnapshotStore, "pre-abort");
        const git = vi.spyOn(fixture.git, "run");
        const quota = vi.spyOn(fixture.store, "getQuotaStatus");
        const controller = new AbortController();
        controller.abort(new Error("cancelled"));

        await expect(
            fixture.store.captureFullReconcile({ profile: "terminal", signal: controller.signal })
        ).rejects.toMatchObject({ code: "capture_timeout" });
        expect(git).not.toHaveBeenCalled();
        expect(quota).not.toHaveBeenCalled();
    });

    test("rejects quota before enumerating or hashing workspace paths", async () => {
        const isolated = await import("./snapshot-store");
        const fixture = await makeFixture(isolated.WorkspaceSnapshotStore, "quota-gate");
        await writeFile(join(fixture.workspace, "target.txt"), "target");
        vi.spyOn(fixture.store, "getQuotaStatus").mockResolvedValue({
            status: "referenced-over-quota",
            usedBytes: 6 * 1024 ** 3,
            referencedBytes: 6 * 1024 ** 3,
            softQuotaBytes: 5 * 1024 ** 3,
        });
        const captureEntries = vi.spyOn(fixture.store, "captureEntries");

        await expect(fixture.store.captureFullReconcile({ profile: "terminal" })).rejects.toMatchObject({
            code: "quota_exceeded",
        });
        expect(captureEntries).not.toHaveBeenCalled();
    });

    test("enforces the ratio-based free-space gate before path capture", async () => {
        vi.doMock("node:fs/promises", async (importOriginal) => {
            const actual = await importOriginal<typeof import("node:fs/promises")>();
            return {
                ...actual,
                statfs: async () => ({
                    type: 0n,
                    bsize: 1024n ** 3n,
                    blocks: 100n,
                    bfree: 4n,
                    bavail: 4n,
                    files: 1n,
                    ffree: 1n,
                }),
            };
        });
        vi.resetModules();
        const isolated = await import("./snapshot-store");
        const fixture = await makeFixture(isolated.WorkspaceSnapshotStore, "free-space");
        const captureEntries = vi.spyOn(fixture.store, "captureEntries");

        await expect(fixture.store.captureFullReconcile({ profile: "terminal" })).rejects.toMatchObject({
            code: "enospc",
        });
        expect(captureEntries).not.toHaveBeenCalled();
    });
});

async function makeFixture(Store: typeof import("./snapshot-store").WorkspaceSnapshotStore, label: string) {
    const root = await mkdtemp(join(tmpdir(), `crest-v3-reconcile-${label}-`));
    CleanupRoots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const identity = await resolveCanonicalWorkspaceIdentity(workspace);
    const { WorkspaceGitRunner } = await import("./git-runner");
    const git = new WorkspaceGitRunner();
    const store = await Store.open({
        dataRoot: join(root, "data"),
        identity,
        git,
        processOwner: { pid: process.pid, processStartToken: label, nonce: "d".repeat(64) },
    });
    return { git, identity, root, store, workspace };
}

async function publishCaptured(
    fixture: Awaited<ReturnType<typeof makeFixture>>,
    captured: ReconciledWorkspaceState,
    turnId: string
) {
    const commit = await fixture.store.mutationLog.append({
        tree: captured.tree,
        metadata: {
            schemaversion: 1,
            workspaceidentity: fixture.identity.workspaceIdentity,
            workspaceincarnation: fixture.identity.workspaceIncarnation,
            kind: "agent-turn",
            sessionid: "reconcile-safety-session",
            turnid: turnId,
        },
    });
    return await fixture.store.publishCommitSnapshot({ commit, ...captured });
}
