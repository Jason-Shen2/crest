// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteSessionStorage } from "@crest/agent/harness/session/sqlite-storage";
import { applyCapturedPath } from "./filesystem-apply";
import { WorkspaceGitRunner } from "./git-runner";
import { makeProcessOwnerIdentity } from "./process-owner";
import { WorkspaceRecoveryJournal } from "./recovery-journal";
import { decodeWorkspaceStateEntry, foldWorkspaceSessionState } from "./session-state";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import type { CapturedPathStateV1 } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import { WorkspaceFrozenError, WorkspaceRecovery } from "./workspace-recovery";

const Boundaries = [
    "operation-ref-before",
    "operation-ref-after",
    "before-prepared",
    "after-prepared",
    "before-applying_files",
    "after-applying_files",
    "path-rename-after-0",
    "path-rename-after-1",
    "before-files_verified",
    "after-files_verified",
    "before-committing_session",
    "after-committing_session",
    "sqlite-cas-before",
    "sqlite-cas-after",
    "before-completed",
    "after-completed",
    "after-journal-remove",
    "operation-ref-remove-before",
    "after-operation-ref-remove",
    "after-operation-owner-remove",
] as const;

type Boundary = (typeof Boundaries)[number];

interface CrashFixtureMetadata {
    identity: CanonicalWorkspaceIdentity;
    dataRoot: string;
    sessionPath: string;
    paths: Array<{ path: string; preState: CapturedPathStateV1; target: CapturedPathStateV1 }>;
}

const cleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("restore crash phase oracle", () => {
    it("awaits durable parent-directory progress before replacing the path", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-restore-parent-progress-"));
        cleanupRoots.push(root);
        const bytes = Buffer.from("target");
        const target = {
            state: "file" as const,
            oid: createHash("sha1")
                .update(Buffer.from(`blob ${bytes.length}\0`))
                .update(bytes)
                .digest("hex"),
            executable: false,
        };
        const order: string[] = [];

        await applyCapturedPath({
            root,
            path: "created/parent/file",
            expectedCurrent: { state: "absent" },
            target,
            readBlob: async () => bytes,
            progress: {
                operationId: "operation-parent-progress",
                createdParentDirectories: new Set(),
                onParentDirectoryCreated: async (path) => {
                    order.push(`parent:${path}`);
                },
                onPathReplaced: async (path) => {
                    order.push(`path:${path}`);
                },
            },
        });

        expect(order).toEqual(["parent:created", "parent:created/parent", "path:created/parent/file"]);
    });

    it.each(Boundaries)(
        "recovers production file and SQLite effects after SIGKILL at %s",
        async (boundary) => {
            const fixture = await crashAt(boundary);
            const expected = expectedRecovery(boundary);
            const recovery = await openRecovery(fixture.metadata);

            await expectCrashBoundaryState(fixture.metadata, recovery.journal, boundary);
            await recovery.coordinator.ensureRecovered(fixture.metadata.identity);
            const firstState = await readRecoveredState(fixture.metadata);
            expect(firstState).toEqual(expected);
            await expect(recovery.journal.read("operation-1")).rejects.toThrow(/not found/i);
            await expect(recovery.store.scanOperationOwners()).resolves.toEqual([]);

            await recovery.coordinator.ensureRecovered(fixture.metadata.identity);
            expect(await readRecoveredState(fixture.metadata)).toEqual(firstState);
            expect((await recovery.session.getEntries()).length).toBe(firstState.entryCount);
            recovery.session.close();
        },
        30_000
    );

    it("freezes repeatably without overwriting an unknown live file", async () => {
        const fixture = await crashAt("path-rename-after-0");
        const manual = Buffer.from("manual edit after crash");
        await writeFile(join(fixture.metadata.identity.canonicalRoot, "first.txt"), manual);
        const recovery = await openRecovery(fixture.metadata);

        await expect(recovery.coordinator.ensureRecovered(fixture.metadata.identity)).rejects.toThrow(
            WorkspaceFrozenError
        );
        await expect(recovery.coordinator.ensureRecovered(fixture.metadata.identity)).rejects.toThrow(
            WorkspaceFrozenError
        );

        expect(await readFile(join(fixture.metadata.identity.canonicalRoot, "first.txt"))).toEqual(manual);
        expect(await recovery.session.getLeafId()).toBe("old-leaf");
        await expect(recovery.journal.read("operation-1")).resolves.toMatchObject({ phase: "applying_files" });
        recovery.session.close();
    }, 30_000);

    it.each(["turn-undo", "turn-redo"] as const)(
        "recovers %s at representative post-phase boundaries",
        async (kind) => {
            const normalFixture = await completeNormally(kind);
            const normal = await readRecoveredState(normalFixture.metadata);
            expect(normal).toEqual(expectedRecovery("sqlite-cas-after", kind));
            expect(normal.workspaceState).toEqual(expectedTurnWorkspaceState(kind));
            for (const boundary of [
                "after-prepared",
                "after-applying_files",
                "after-files_verified",
                "after-committing_session",
                "sqlite-cas-after",
            ] as const) {
                const fixture = await crashAt(boundary, kind);
                const recovery = await openRecovery(fixture.metadata);

                await recovery.coordinator.ensureRecovered(fixture.metadata.identity);

                const recovered = await readRecoveredState(fixture.metadata);
                expect(recovered).toEqual(expectedRecovery(boundary, kind));
                if (recovered.workspaceState) {
                    expect(recovered.workspaceState).toEqual(normal.workspaceState);
                    expect({ semanticLeaf: recovered.semanticLeaf, displayLeaf: recovered.displayLeaf }).toEqual({
                        semanticLeaf: normal.semanticLeaf,
                        displayLeaf: normal.displayLeaf,
                    });
                } else {
                    expect(recovered).toMatchObject({
                        leaf: "old-leaf",
                        semanticLeaf: "old-leaf",
                        displayLeaf: "old-leaf",
                    });
                }
                await expect(recovery.journal.read("operation-1")).rejects.toThrow(/not found/i);
                recovery.session.close();
            }
        },
        30_000
    );

    it.each(["turn-undo", "turn-redo"] as const)("freezes %s without replacing third-party bytes", async (kind) => {
        const fixture = await crashAt("path-rename-after-0", kind);
        const manual = Buffer.from(`manual ${kind}`);
        await writeFile(join(fixture.metadata.identity.canonicalRoot, "first.txt"), manual);
        const recovery = await openRecovery(fixture.metadata);

        await expect(recovery.coordinator.ensureRecovered(fixture.metadata.identity)).rejects.toThrow(
            WorkspaceFrozenError
        );

        expect(await readFile(join(fixture.metadata.identity.canonicalRoot, "first.txt"))).toEqual(manual);
        await expect(recovery.journal.read("operation-1")).resolves.toMatchObject({
            phase: "applying_files",
            target: expect.objectContaining({ kind }),
        });
        recovery.session.close();
    });
});

async function crashAt(
    boundary: Boundary,
    kind: "rewind" | "turn-undo" | "turn-redo" = "rewind"
): Promise<{ root: string; metadata: CrashFixtureMetadata }> {
    const root = await mkdtemp(join(tmpdir(), "crest-restore-crash-"));
    cleanupRoots.push(root);
    const workerPath = resolve("packages/coding-agent/workspace-rewind/fixtures/restore-crash-worker.ts");
    const child = fork(workerPath, [root, boundary, kind], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (bytes) => {
        stderr += bytes.toString("utf8");
    });
    await new Promise<void>((resolveReady, reject) => {
        child.once("message", () => resolveReady());
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            reject(new Error(`restore crash worker exited before ${boundary}: ${String(code ?? signal)} ${stderr}`));
        });
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    const metadata = JSON.parse(await readFile(join(root, "fixture.json"), "utf8")) as CrashFixtureMetadata;
    return { root, metadata };
}

async function completeNormally(
    kind: "turn-undo" | "turn-redo"
): Promise<{ root: string; metadata: CrashFixtureMetadata }> {
    const root = await mkdtemp(join(tmpdir(), "crest-restore-normal-"));
    cleanupRoots.push(root);
    const workerPath = resolve("packages/coding-agent/workspace-rewind/fixtures/restore-crash-worker.ts");
    const child = fork(workerPath, [root, "normal-completion", kind], {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr?.on("data", (bytes) => {
        stderr += bytes.toString("utf8");
    });
    await new Promise<void>((resolveCompleted, reject) => {
        child.once("message", (message) => {
            if (message === "completed") resolveCompleted();
            else reject(new Error(`restore normal worker sent an unexpected message: ${String(message)}`));
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) return;
            reject(new Error(`restore normal worker failed: ${String(code ?? signal)} ${stderr}`));
        });
    });
    if (child.exitCode == null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    }
    const metadata = JSON.parse(await readFile(join(root, "fixture.json"), "utf8")) as CrashFixtureMetadata;
    return { root, metadata };
}

async function openRecovery(metadata: CrashFixtureMetadata) {
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: metadata.dataRoot,
        identity: metadata.identity,
        git: new WorkspaceGitRunner(),
        processOwner: await makeProcessOwnerIdentity(),
    });
    const session = SqliteSessionStorage.open(metadata.sessionPath);
    const journal = new WorkspaceRecoveryJournal(store);
    const coordinator = new WorkspaceRecovery({
        workspace: metadata.identity,
        store,
        journal,
        locateSession: async (sessionId) => (sessionId === "session-1" ? session : undefined),
        verifyWorkspace: async () => {},
    });
    return { coordinator, journal, session, store };
}

async function readRecoveredState(metadata: CrashFixtureMetadata) {
    const session = SqliteSessionStorage.open(metadata.sessionPath);
    try {
        const entries = await session.getEntries();
        const operationEntry = entries.find((entry) => entry.id === "operation-leaf");
        const state = operationEntry ? decodeWorkspaceStateEntry(operationEntry) : undefined;
        const folded = foldWorkspaceSessionState(entries, "session-1");
        return {
            first: await readFile(join(metadata.identity.canonicalRoot, "first.txt"), "utf8"),
            second: await readFile(join(metadata.identity.canonicalRoot, "second.txt"), "utf8"),
            leaf: await session.getLeafId(),
            semanticLeaf: folded.semanticLeafId,
            displayLeaf: folded.displayLeafId,
            entryCount: entries.length,
            workspaceState:
                state && operationEntry
                    ? {
                          parentId: operationEntry.parentId,
                          kind: state.kind,
                          ...(state.kind === "turn-undo" || state.kind === "turn-redo"
                              ? { sourceTurnId: state.sourceTurnId }
                              : {}),
                          ...(state.kind === "turn-redo" ? { undoOperationId: state.undoOperationId } : {}),
                      }
                    : undefined,
        };
    } finally {
        session.close();
    }
}

function expectedRecovery(boundary: Boundary, kind: "rewind" | "turn-undo" | "turn-redo" = "rewind") {
    const completed = Boundaries.indexOf(boundary) >= Boundaries.indexOf("sqlite-cas-after");
    return {
        first: completed ? "target first" : "pre first",
        second: completed ? "target second" : "pre second",
        leaf: completed ? "operation-leaf" : "old-leaf",
        semanticLeaf: completed ? "operation-leaf" : "old-leaf",
        displayLeaf: completed && kind === "rewind" ? "target-boundary" : "old-leaf",
        entryCount: completed ? 3 : 2,
        workspaceState:
            completed && kind !== "rewind"
                ? expectedTurnWorkspaceState(kind)
                : completed
                  ? { parentId: "target-boundary", kind: "rewind" }
                  : undefined,
    };
}

function expectedTurnWorkspaceState(kind: "turn-undo" | "turn-redo") {
    return {
        parentId: "old-leaf",
        kind,
        sourceTurnId: "source-turn",
        ...(kind === "turn-redo" ? { undoOperationId: "undo-operation" } : {}),
    };
}

async function expectCrashBoundaryState(
    metadata: CrashFixtureMetadata,
    journal: WorkspaceRecoveryJournal,
    boundary: Boundary
): Promise<void> {
    const expectedPhase = expectedDurablePhase(boundary);
    if (expectedPhase) {
        await expect(journal.read("operation-1")).resolves.toMatchObject({ phase: expectedPhase });
    } else {
        await expect(journal.read("operation-1")).rejects.toThrow(/not found/i);
    }
    const state = await readRecoveredState(metadata);
    expect(state).toEqual({
        ...expectedRecovery(boundary),
        first: Boundaries.indexOf(boundary) >= Boundaries.indexOf("path-rename-after-0") ? "target first" : "pre first",
        second:
            Boundaries.indexOf(boundary) >= Boundaries.indexOf("path-rename-after-1") ? "target second" : "pre second",
    });
}

function expectedDurablePhase(boundary: Boundary): string | undefined {
    if (boundary === "operation-ref-before" || boundary === "operation-ref-after" || boundary === "before-prepared") {
        return undefined;
    }
    if (boundary === "after-prepared" || boundary === "before-applying_files") {
        return "prepared";
    }
    if (
        boundary === "after-applying_files" ||
        boundary === "path-rename-after-0" ||
        boundary === "path-rename-after-1" ||
        boundary === "before-files_verified"
    ) {
        return "applying_files";
    }
    if (boundary === "after-files_verified" || boundary === "before-committing_session") {
        return "files_verified";
    }
    if (
        boundary === "after-committing_session" ||
        boundary === "sqlite-cas-before" ||
        boundary === "sqlite-cas-after" ||
        boundary === "before-completed"
    ) {
        return "committing_session";
    }
    if (boundary === "after-completed") {
        return "completed";
    }
    return undefined;
}
