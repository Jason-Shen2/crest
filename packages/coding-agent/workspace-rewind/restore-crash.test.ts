// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Session } from "@crest/agent/harness/session/session";
import { SqliteSessionStorage } from "@crest/agent/harness/session/sqlite-storage";
import { fork, type ChildProcess } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveWorkspaceApplyArtifactPaths } from "./filesystem-apply";
import { WorkspaceGitRunner } from "./git-runner";
import { PendingWorkspaceRestoreStore } from "./pending-restore-store";
import { decodeWorkspaceStateEntry } from "./session-state";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import type { CapturedPathStateV1 } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import { WorkspaceRecovery } from "./workspace-recovery";

type RestoreCrashBoundary =
    | "before-pending-publish"
    | "after-pending-publish"
    | `path-replace-before-${number}`
    | `path-replace-after-${number}`
    | "before-result-snapshot"
    | "after-result-snapshot"
    | "sqlite-marker-before"
    | "sqlite-marker-after"
    | "pending-remove-before"
    | "pending-remove-after";

type OperationKind = "conversation-rewind" | "conversation-redo" | "turn-undo" | "turn-redo";

const BoundaryMatrix = [
    { boundary: "before-pending-publish", implemented: true },
    { boundary: "after-pending-publish", implemented: true },
    { boundary: "path-replace-before-0", implemented: true },
    { boundary: "path-replace-after-0", implemented: true },
    { boundary: "path-replace-before-1", implemented: true },
    { boundary: "path-replace-after-1", implemented: true },
    { boundary: "path-replace-before-2", implemented: true },
    { boundary: "path-replace-after-2", implemented: true },
    { boundary: "before-result-snapshot", implemented: true },
    { boundary: "after-result-snapshot", implemented: true },
    { boundary: "sqlite-marker-before", implemented: true },
    { boundary: "sqlite-marker-after", implemented: true },
    { boundary: "pending-remove-before", implemented: true },
    { boundary: "pending-remove-after", implemented: true },
] as const satisfies ReadonlyArray<{ boundary: RestoreCrashBoundary; implemented: boolean }>;

const ExecutedBoundaries = BoundaryMatrix.filter((item) => item.implemented);
const OperationKinds = ["conversation-rewind", "conversation-redo", "turn-undo", "turn-redo"] as const;
const CleanupRoots: string[] = [];
const RecoveryProcessOwner = {
    pid: process.pid,
    processStartToken: "restore-crash-test",
    nonce: "4".repeat(64),
};

interface CrashFixtureMetadata {
    identity: CanonicalWorkspaceIdentity;
    dataRoot: string;
    sessionPath: string;
    operationKind: OperationKind;
    paths: Array<{ path: string; before: CapturedPathStateV1; target: CapturedPathStateV1 }>;
}

afterEach(async () => {
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("phase-free restore crash matrix", () => {
    it("uses process-group kill on POSIX and child kill on Windows", () => {
        const childKill = vi.fn(() => true);
        const groupKill = vi.fn();
        const child = { pid: 42, kill: childKill } as unknown as ChildProcess;

        killCrashWorker(child, "darwin", groupKill);
        expect(groupKill).toHaveBeenCalledWith(-42, "SIGKILL");
        expect(childKill).not.toHaveBeenCalled();

        groupKill.mockClear();
        killCrashWorker(child, "win32", groupKill);
        expect(childKill).toHaveBeenCalledWith("SIGKILL");
        expect(groupKill).not.toHaveBeenCalled();
    });

    it("does not retain the legacy operation-owner API beside the pending protocol", () => {
        expect(
            Object.getOwnPropertyNames(WorkspaceSnapshotStore.prototype).filter((name) =>
                /operation.*owner/i.test(name)
            )
        ).toEqual([]);
    });

    it.each(OperationKinds)(
        "recovers all implemented boundaries for %s",
        async (operationKind) => {
            for (const { boundary } of ExecutedBoundaries) {
                const fixture = await crashAt(boundary, operationKind);
                const recovered = await recover(fixture.metadata);
                const targetOutcome =
                    boundary === "sqlite-marker-after" ||
                    boundary === "pending-remove-before" ||
                    boundary === "pending-remove-after";
                const decisionState =
                    boundary === "before-pending-publish" || boundary === "pending-remove-after"
                        ? "none"
                        : targetOutcome
                          ? "committed"
                          : "not-committed";

                expect(recovered.decision).toEqual(
                    decisionState === "none" ? { state: "none" } : { state: decisionState, operationId: "operation-1" }
                );
                expect(recovered.first).toBe(targetOutcome ? "target first" : "before first");
                expect(recovered.second).toBe(targetOutcome ? "target second" : "before second");
                expect(recovered.third).toBe(targetOutcome ? "target third" : undefined);
                expect(recovered.leafId).toBe(targetOutcome ? "operation-leaf" : "old-leaf");
                expect(recovered.pending).toEqual({ kind: "none" });
                expect(recovered.markerKind).toBe(targetOutcome ? durableKind(operationKind) : undefined);
                expect(await recovered.recovery.resolvePending()).toEqual({ state: "none" });
                recovered.session.close();
            }
        },
        120_000
    );

    it("does not overwrite an unknown external write after restart", async () => {
        const fixture = await crashAt("after-pending-publish", "conversation-rewind");
        const manual = "external bytes";
        await writeFile(join(fixture.metadata.identity.canonicalRoot, "first.txt"), manual);
        const recovered = await recover(fixture.metadata);

        expect(recovered.decision).toMatchObject({
            state: "needs-user",
            view: { paths: expect.arrayContaining([{ path: "first.txt", classification: "unknown" }]) },
        });
        expect(recovered.first).toBe(manual);
        expect(recovered.pending).toMatchObject({ kind: "valid" });
        recovered.session.close();
    }, 30_000);

    it("reconciles pre-crash rename and install artifacts through production recovery", async () => {
        const fixture = await crashAt("after-pending-publish", "conversation-redo", "artifacts");
        const root = fixture.metadata.identity.canonicalRoot;
        const renamed = deriveWorkspaceApplyArtifactPaths({ operationId: "operation-1", path: "first.txt" });
        const installed = deriveWorkspaceApplyArtifactPaths({ operationId: "operation-1", path: "second.txt" });
        await expect(lstat(join(root, renamed.preparedFile))).resolves.toBeDefined();
        await expect(lstat(join(root, renamed.quarantine, "entry"))).resolves.toBeDefined();
        await expect(lstat(join(root, installed.quarantine, "entry"))).resolves.toBeDefined();

        const recovered = await recover(fixture.metadata);

        expect(recovered.decision).toEqual({ state: "not-committed", operationId: "operation-1" });
        expect(recovered).toMatchObject({ first: "before first", second: "before second", pending: { kind: "none" } });
        for (const artifact of [renamed.preparedFile, `${renamed.quarantine}/entry`, `${installed.quarantine}/entry`]) {
            await expect(lstat(join(root, artifact))).rejects.toMatchObject({ code: "ENOENT" });
        }
        recovered.session.close();
    }, 30_000);

    it("replays persisted created-parent progress idempotently", async () => {
        const fixture = await crashAt("path-replace-after-2", "turn-undo");
        const pendingBefore = await readPending(fixture.metadata);
        expect(pendingBefore).toMatchObject({
            kind: "valid",
            record: {
                paths: expect.arrayContaining([
                    expect.objectContaining({
                        path: "created/parent/third.txt",
                        createdParentDirectories: ["created", "created/parent"],
                    }),
                ]),
            },
        });

        const recovered = await recover(fixture.metadata);
        expect(recovered.decision).toEqual({ state: "not-committed", operationId: "operation-1" });
        expect(await recovered.recovery.resolvePending()).toEqual({ state: "none" });
        await expect(lstat(join(fixture.metadata.identity.canonicalRoot, "created"))).rejects.toMatchObject({
            code: "ENOENT",
        });
        recovered.session.close();
    }, 30_000);
});

async function crashAt(
    boundary: RestoreCrashBoundary,
    operationKind: OperationKind,
    scenario: "normal" | "artifacts" = "normal"
): Promise<{ root: string; metadata: CrashFixtureMetadata }> {
    const root = await mkdtemp(join(tmpdir(), "crest-restore-crash-"));
    CleanupRoots.push(root);
    const workerPath = resolve("packages/coding-agent/workspace-rewind/fixtures/restore-crash-worker.ts");
    const child = fork(workerPath, [root, boundary, operationKind, scenario], {
        detached: true,
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (bytes) => {
        stderr += bytes.toString("utf8");
    });
    await new Promise<void>((ready, reject) => {
        const timer = setTimeout(() => {
            killCrashWorker(child);
            reject(new Error(`restore crash worker timed out before ${boundary}: ${stderr}`));
        }, 20_000);
        child.once("message", (message) => {
            clearTimeout(timer);
            if (message === "ready") ready();
            else reject(new Error(`restore crash worker sent an unexpected message: ${String(message)}`));
        });
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("exit", (code, signal) => {
            clearTimeout(timer);
            reject(new Error(`restore crash worker exited before ${boundary}: ${String(code ?? signal)} ${stderr}`));
        });
    });
    killCrashWorker(child);
    await new Promise<void>((exited) => child.once("exit", () => exited()));
    const metadata = JSON.parse(await readFile(join(root, "fixture.json"), "utf8")) as CrashFixtureMetadata;
    return { root, metadata };
}

function killCrashWorker(
    child: ChildProcess,
    platform: NodeJS.Platform = process.platform,
    killProcess: (pid: number, signal: NodeJS.Signals) => void = process.kill
): void {
    if (platform === "win32") {
        child.kill("SIGKILL");
        return;
    }
    if (child.pid == null) throw new Error("Restore crash worker has no process id");
    killProcess(-child.pid, "SIGKILL");
}

async function recover(metadata: CrashFixtureMetadata) {
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: metadata.dataRoot,
        identity: metadata.identity,
        git: new WorkspaceGitRunner(),
        processOwner: RecoveryProcessOwner,
    });
    const session = new Session(SqliteSessionStorage.open(metadata.sessionPath));
    const pendingStore = new PendingWorkspaceRestoreStore(store);
    const recovery = new WorkspaceRecovery({
        workspace: metadata.identity,
        store,
        pending: pendingStore,
        locateSession: async (sessionId, sessionPath) =>
            sessionId === "session-1" && sessionPath === metadata.sessionPath ? session : undefined,
        verifyWorkspace: async () => {},
    });
    const decision = await recovery.resolvePending();
    const marker = await session.getEntry("operation-leaf");
    const state = marker ? decodeWorkspaceStateEntry(marker) : undefined;
    return {
        decision,
        recovery,
        session,
        pending: await pendingStore.readCandidate(),
        first: await readFile(join(metadata.identity.canonicalRoot, "first.txt"), "utf8"),
        second: await readFile(join(metadata.identity.canonicalRoot, "second.txt"), "utf8"),
        third: await readOptional(join(metadata.identity.canonicalRoot, "created/parent/third.txt")),
        leafId: await session.getLeafId(),
        markerKind: state?.kind,
    };
}

async function readPending(metadata: CrashFixtureMetadata) {
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: metadata.dataRoot,
        identity: metadata.identity,
        git: new WorkspaceGitRunner(),
        processOwner: RecoveryProcessOwner,
    });
    return new PendingWorkspaceRestoreStore(store).readCandidate();
}

async function readOptional(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

function durableKind(kind: OperationKind): "rewind" | "redo" | "turn-undo" | "turn-redo" {
    if (kind === "conversation-rewind") return "rewind";
    if (kind === "conversation-redo") return "redo";
    return kind;
}
