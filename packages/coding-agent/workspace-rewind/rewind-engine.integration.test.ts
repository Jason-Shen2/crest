// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { SqliteSessionRepo } from "@crest/agent/harness/session/sqlite-repo";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    realpath,
    rename,
    rm,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RewindConfirmationRegistry } from "./confirmation-token";
import { applyCapturedPath, verifyCapturedPath } from "./filesystem-apply";
import { WorkspaceGitRunner } from "./git-runner";
import { PendingWorkspaceRestoreStore } from "./pending-restore-store";
import { WorkspaceRewindEngine, type WorkspaceRewindEngineOptions } from "./rewind-engine";
import { decodeWorkspaceStateEntry } from "./session-state";
import { initializeWorkspaceCheckpointSnapshotSource } from "./snapshot-source";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import { WorkspaceControlCustomTypes, type WorkspaceCheckpointV1 } from "./types";
import type { WorkspaceChangeDrain, WorkspaceChangeFeed } from "./workspace-change-feed";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import { WorkspaceFrozenError, WorkspaceRecovery } from "./workspace-recovery";
import { WorkspaceSnapshotTracker } from "./workspace-snapshot-tracker";

const cleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function ancestorIdentityChain(path: string): Promise<CanonicalWorkspaceIdentity["ancestorIdentityChain"]> {
    const paths: string[] = [];
    let cursor = path;
    while (true) {
        paths.unshift(cursor);
        const parent = dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
    }
    return Promise.all(
        paths.map(async (absolutePath) => {
            const state = await lstat(absolutePath, { bigint: true });
            return {
                absolutePath,
                dev: state.dev.toString(),
                ino: state.ino.toString(),
                birthtimeNs: state.birthtimeNs.toString(),
            };
        })
    );
}

async function fixture(
    options: {
        applyPath?: (workspaceRoot: string) => NonNullable<WorkspaceRewindEngineOptions["applyPath"]>;
        verifyPath?: (workspaceRoot: string) => NonNullable<WorkspaceRewindEngineOptions["verifyPath"]>;
        locateSession?: NonNullable<WorkspaceRewindEngineOptions["locateSession"]>;
    } = {}
) {
    const root = await mkdtemp(join(tmpdir(), "crest-rewind-engine-"));
    cleanupRoots.push(root);
    const workspaceRoot = await realpath(await mkdir(join(root, "workspace"), { recursive: true }));
    const identity: CanonicalWorkspaceIdentity = {
        canonicalRoot: workspaceRoot,
        workspaceIdentity: "1".repeat(64),
        workspaceIncarnation: "2".repeat(64),
        storeKey: "rewind-engine-integration",
        ancestorIdentityChain: await ancestorIdentityChain(workspaceRoot),
    };
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: join(root, "data"),
        identity,
        git: new WorkspaceGitRunner(),
        processOwner: {
            pid: process.pid,
            processStartToken: "integration-test",
            nonce: "3".repeat(64),
        },
    });
    const repo = new SqliteSessionRepo({ sessionsRoot: join(root, "sessions") });
    const session = await repo.create({ cwd: workspaceRoot, id: "session-1" });
    const metadata = await session.getMetadata();
    const pending = new PendingWorkspaceRestoreStore(store);
    const published = vi.fn(async () => {});
    const recovery = new WorkspaceRecovery({
        workspace: identity,
        store,
        pending,
        locateSession:
            options.locateSession ?? (async (sessionId) => (sessionId === metadata.id ? session : undefined)),
        verifyWorkspace: vi.fn(async () => {}),
        withSessionMutation: async (_sessionPath, operation) => await operation(),
    });
    const confirmations = new RewindConfirmationRegistry();
    const snapshotSource = await initializeWorkspaceCheckpointSnapshotSource({
        store,
        legacyCapture: store,
    });
    const engine = new WorkspaceRewindEngine({
        store,
        pending,
        recovery,
        confirmations,
        snapshotSource,
        onCommitted: published,
        applyPath: options.applyPath?.(workspaceRoot),
        verifyPath: options.verifyPath?.(workspaceRoot),
    });
    return {
        root,
        workspaceRoot,
        identity,
        store,
        session,
        metadata,
        pending,
        recovery,
        confirmations,
        snapshotSource,
        engine,
        published,
    };
}

async function appendAvailableCheckpoint(
    value: Awaited<ReturnType<typeof fixture>>,
    prompt: string,
    mutate: () => Promise<void>
) {
    const before = await value.snapshotSource.synchronizeExternal();
    const turnId = await value.session.appendMessage({
        role: "user",
        content: prompt,
        timestamp: Date.now(),
    } as never);
    await mutate();
    const after = await value.snapshotSource.captureOwnedTurn({
        base: before.ref,
        sessionId: value.metadata.id,
        turnId,
    });
    const checkpoint: WorkspaceCheckpointV1 = {
        schemaVersion: 1,
        status: "available",
        originSessionId: value.metadata.id,
        turnId,
        workspaceIdentity: value.identity.workspaceIdentity,
        workspaceIncarnation: value.identity.workspaceIncarnation,
        before: before.ref,
        after: after.after,
        changes: after.changes,
        coverage: after.coverage,
    };
    const checkpointId = await value.session.appendCustomEntry(WorkspaceControlCustomTypes.checkpoint, checkpoint);
    return { turnId, checkpointId };
}

describe("WorkspaceRewindEngine real filesystem transaction", () => {
    it("rewinds an incremental directory rename checkpoint with the same path set as a full snapshot", async () => {
        const value = await fixture();
        await mkdir(join(value.workspaceRoot, "old-dir", "nested"), { recursive: true });
        await writeFile(join(value.workspaceRoot, "old-dir", "a.txt"), "a");
        await writeFile(join(value.workspaceRoot, "old-dir", "nested", "b.txt"), "b");
        const feed = new BoundaryChangeFeed();
        const tracker = new WorkspaceSnapshotTracker({
            store: value.store,
            feed,
            state: {
                load: async () => ({ status: "untrusted" }),
                publish: async () => undefined,
            },
        });
        try {
            const source = await initializeWorkspaceCheckpointSnapshotSource({
                store: value.store,
                legacyCapture: value.store,
            });
            const checkpointBefore = await source.synchronizeExternal();
            const before = await tracker.capture({ profile: "pre-turn" });
            const turnId = await value.session.appendMessage({
                role: "user",
                content: "rename directory",
                timestamp: Date.now(),
            } as never);
            await rename(join(value.workspaceRoot, "old-dir"), join(value.workspaceRoot, "new-dir"));
            feed.record(["old-dir", "new-dir"]);
            const after = await tracker.capture({ profile: "terminal" });
            const changes = await tracker.diff(before.ref, after.ref);
            const checkpointAfter = await source.captureOwnedTurn({
                base: checkpointBefore.ref,
                sessionId: value.metadata.id,
                turnId,
            });
            const checkpointId = await value.session.appendCustomEntry(WorkspaceControlCustomTypes.checkpoint, {
                schemaVersion: 1,
                status: "available",
                originSessionId: value.metadata.id,
                turnId,
                workspaceIdentity: value.identity.workspaceIdentity,
                workspaceIncarnation: value.identity.workspaceIncarnation,
                before: checkpointBefore.ref,
                after: checkpointAfter.after,
                changes: checkpointAfter.changes,
                coverage: checkpointAfter.coverage,
            } satisfies WorkspaceCheckpointV1);

            expect(changes.map((change) => change.path)).toEqual([
                "new-dir/a.txt",
                "new-dir/nested/b.txt",
                "old-dir/a.txt",
                "old-dir/nested/b.txt",
            ]);
            const preview = await value.engine.previewRewind({
                session: value.session,
                sessionId: value.metadata.id,
                workspace: value.identity,
                semanticLeafId: checkpointId,
                targetTurnId: turnId,
            });
            await value.engine.applyRewind({
                session: value.session,
                sessionId: value.metadata.id,
                workspace: value.identity,
                semanticLeafId: checkpointId,
                targetTurnId: turnId,
                mode: "normal",
                confirmation: value.confirmations.take(preview.confirmationToken!),
            });

            expect(await readFile(join(value.workspaceRoot, "old-dir", "a.txt"), "utf8")).toBe("a");
            expect(await readFile(join(value.workspaceRoot, "old-dir", "nested", "b.txt"), "utf8")).toBe("b");
            await expect(lstat(join(value.workspaceRoot, "new-dir", "a.txt"))).rejects.toMatchObject({
                code: "ENOENT",
            });
            await expect(lstat(join(value.workspaceRoot, "new-dir", "nested", "b.txt"))).rejects.toMatchObject({
                code: "ENOENT",
            });
        } finally {
            await tracker.dispose();
        }
    }, 30_000);

    it("composes turn Undo state into a later conversation Revert without restoring stale turn bytes", async () => {
        const value = await fixture();
        const file = join(value.workspaceRoot, "sequence.txt");
        await writeFile(file, "0");
        const turn1 = await appendAvailableCheckpoint(value, "turn one", async () => await writeFile(file, "1"));
        const turn2 = await appendAvailableCheckpoint(value, "turn two", async () => await writeFile(file, "2"));

        const undoPreview = await value.engine.previewTurnUndo({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.identity,
            semanticLeafId: turn2.checkpointId,
            sourceTurnId: turn2.turnId,
        });
        const undone = await value.engine.applyTurnUndo({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.identity,
            semanticLeafId: turn2.checkpointId,
            sourceTurnId: turn2.turnId,
            mode: "normal",
            confirmation: value.confirmations.take(undoPreview.confirmationToken!),
        });
        expect(await readFile(file, "utf8")).toBe("1");

        const rewindPreview = await value.engine.previewRewind({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.identity,
            semanticLeafId: undone.semanticLeafId,
            targetTurnId: turn1.turnId,
        });
        await value.engine.applyRewind({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.identity,
            semanticLeafId: undone.semanticLeafId,
            targetTurnId: turn1.turnId,
            mode: "normal",
            confirmation: value.confirmations.take(rewindPreview.confirmationToken!),
        });

        expect(await readFile(file, "utf8")).toBe("0");
    }, 30_000);

    it("restores absent/rename/binary/symlink/executable states and redo restores the exact safety bytes", async () => {
        const value = await fixture();
        const binaryBefore = Buffer.from([0, 1, 2, 255, 10]);
        const binaryAfter = Buffer.from([9, 8, 0, 7, 255]);
        await writeFile(join(value.workspaceRoot, "old-name.txt"), "old name");
        await writeFile(join(value.workspaceRoot, "binary.bin"), binaryBefore);
        await writeFile(join(value.workspaceRoot, "run.sh"), "#!/bin/sh\necho before\n");
        await chmod(join(value.workspaceRoot, "run.sh"), 0o755);
        await symlink("before-target", join(value.workspaceRoot, "link"));
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store: value.store,
            legacyCapture: value.store,
        });
        const before = await source.synchronizeExternal();

        const turnId = await value.session.appendMessage({
            role: "user",
            content: [
                { type: "text", text: "put " },
                { type: "image", data: "ignored", mimeType: "image/png" },
                { type: "text", text: "it back" },
            ],
            timestamp: Date.now(),
        } as never);
        await rename(join(value.workspaceRoot, "old-name.txt"), join(value.workspaceRoot, "new-name.txt"));
        await writeFile(join(value.workspaceRoot, "binary.bin"), binaryAfter);
        await writeFile(join(value.workspaceRoot, "run.sh"), "#!/bin/sh\necho after\n");
        await chmod(join(value.workspaceRoot, "run.sh"), 0o644);
        await unlink(join(value.workspaceRoot, "link"));
        await symlink("after-target", join(value.workspaceRoot, "link"));
        await writeFile(join(value.workspaceRoot, "created.txt"), "created after");
        const after = await source.captureOwnedTurn({
            base: before.ref,
            sessionId: value.metadata.id,
            turnId,
        });
        const checkpoint: WorkspaceCheckpointV1 = {
            schemaVersion: 1,
            status: "available",
            originSessionId: value.metadata.id,
            turnId,
            workspaceIdentity: value.identity.workspaceIdentity,
            workspaceIncarnation: value.identity.workspaceIncarnation,
            before: before.ref,
            after: after.after,
            changes: after.changes,
            coverage: after.coverage,
        };
        const checkpointId = await value.session.appendCustomEntry(WorkspaceControlCustomTypes.checkpoint, checkpoint);

        const preview = await value.engine.previewRewind({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.identity,
            semanticLeafId: checkpointId,
            targetTurnId: turnId,
        });
        const rewind = await value.engine.applyRewind({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.identity,
            semanticLeafId: checkpointId,
            targetTurnId: turnId,
            mode: "normal",
            confirmation: value.confirmations.take(preview.confirmationToken!),
        });

        expect(rewind.editorText).toBe("put it back");
        expect(await readFile(join(value.workspaceRoot, "old-name.txt"), "utf8")).toBe("old name");
        await expect(readFile(join(value.workspaceRoot, "new-name.txt"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(value.workspaceRoot, "created.txt"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(join(value.workspaceRoot, "binary.bin"))).toEqual(binaryBefore);
        expect((await lstat(join(value.workspaceRoot, "run.sh"))).mode & 0o111).not.toBe(0);
        expect(await readlink(join(value.workspaceRoot, "link"))).toBe("before-target");

        const rewindEntry = await value.session.getEntry(rewind.semanticLeafId!);
        const rewindState = decodeWorkspaceStateEntry(rewindEntry!);
        expect(rewindEntry?.parentId).toBeNull();
        expect(rewindState).toMatchObject({
            kind: "rewind",
            rewind: {
                fromLeafId: checkpointId,
                targetTurnId: turnId,
                targetBoundaryId: null,
            },
        });

        const redoPreview = await value.engine.previewRedo({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.identity,
            semanticLeafId: rewind.semanticLeafId,
        });
        expect(redoPreview.forceRequired).toBe(false);
        expect(redoPreview.hardBlocked, JSON.stringify(redoPreview.coverageWarnings)).toBe(false);
        expect(redoPreview.confirmationToken).toBeTypeOf("string");
        const redo = await value.engine.applyRedo({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.identity,
            semanticLeafId: rewind.semanticLeafId,
            confirmation: value.confirmations.take(redoPreview.confirmationToken!),
        });

        await expect(readFile(join(value.workspaceRoot, "old-name.txt"))).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(join(value.workspaceRoot, "new-name.txt"), "utf8")).toBe("old name");
        expect(await readFile(join(value.workspaceRoot, "created.txt"), "utf8")).toBe("created after");
        expect(await readFile(join(value.workspaceRoot, "binary.bin"))).toEqual(binaryAfter);
        expect((await lstat(join(value.workspaceRoot, "run.sh"))).mode & 0o111).toBe(0);
        expect(await readlink(join(value.workspaceRoot, "link"))).toBe("after-target");

        const redoEntry = await value.session.getEntry(redo.semanticLeafId!);
        const redoState = decodeWorkspaceStateEntry(redoEntry!);
        expect(redoEntry?.parentId).toBe(checkpointId);
        expect(redoState).toMatchObject({ kind: "redo", applyMode: "normal", forcedPaths: [] });
        expect(redoState?.rewind).toBeUndefined();
        await expect(value.pending.readLocked()).resolves.toEqual({ kind: "none" });
        await value.store.verify(redoState!.currentSnapshot);
        for (const item of redoState!.currentStates) {
            await expect(value.store.readPathState(redoState!.currentSnapshot, item.path)).resolves.toEqual(item.state);
        }
        expect(value.published).toHaveBeenCalledTimes(2);
    }, 30_000);

    it("blocks redo drift without issuing Force authority", async () => {
        const value = await fixture();
        await writeFile(join(value.workspaceRoot, "file.txt"), "before");
        const source = await initializeWorkspaceCheckpointSnapshotSource({
            store: value.store,
            legacyCapture: value.store,
        });
        const before = await source.synchronizeExternal();
        const turnId = await value.session.appendMessage({
            role: "user",
            content: "change",
            timestamp: Date.now(),
        } as never);
        await writeFile(join(value.workspaceRoot, "file.txt"), "after");
        const after = await source.captureOwnedTurn({
            base: before.ref,
            sessionId: value.metadata.id,
            turnId,
        });
        const checkpointId = await value.session.appendCustomEntry(WorkspaceControlCustomTypes.checkpoint, {
            schemaVersion: 1,
            status: "available",
            originSessionId: value.metadata.id,
            turnId,
            workspaceIdentity: value.identity.workspaceIdentity,
            workspaceIncarnation: value.identity.workspaceIncarnation,
            before: before.ref,
            after: after.after,
            changes: after.changes,
            coverage: after.coverage,
        } satisfies WorkspaceCheckpointV1);
        const preview = await value.engine.previewRewind({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.identity,
            semanticLeafId: checkpointId,
            targetTurnId: turnId,
        });
        const rewind = await value.engine.applyRewind({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.identity,
            semanticLeafId: checkpointId,
            targetTurnId: turnId,
            mode: "normal",
            confirmation: value.confirmations.take(preview.confirmationToken!),
        });
        await writeFile(join(value.workspaceRoot, "file.txt"), "manual drift");

        const redo = await value.engine.previewRedo({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.identity,
            semanticLeafId: rewind.semanticLeafId,
        });

        expect(redo).toMatchObject({ hardBlocked: true, forceRequired: false });
        expect(redo.confirmationToken).toBeUndefined();
        expect(redo.files[0]).toMatchObject({ conflict: "hard-blocker" });
    }, 30_000);

    it.each(["normal", "force-drift"] as const)(
        "freezes without overwriting third-party bytes inserted after final drift validation in %s mode",
        async (mode) => {
            let injected = false;
            const value = await fixture({
                applyPath: (workspaceRoot) => async (input) => {
                    if (!injected) {
                        injected = true;
                        await writeFile(join(workspaceRoot, "b.txt"), "third party");
                    }
                    await applyCapturedPath(input);
                },
            });
            await writeFile(join(value.workspaceRoot, "a.txt"), "before a");
            await writeFile(join(value.workspaceRoot, "b.txt"), "before b");
            const source = await initializeWorkspaceCheckpointSnapshotSource({
                store: value.store,
                legacyCapture: value.store,
            });
            const before = await source.synchronizeExternal();
            const turnId = await value.session.appendMessage({
                role: "user",
                content: "change both",
                timestamp: Date.now(),
            } as never);
            await writeFile(join(value.workspaceRoot, "a.txt"), "after a");
            await writeFile(join(value.workspaceRoot, "b.txt"), "after b");
            const after = await source.captureOwnedTurn({
                base: before.ref,
                sessionId: value.metadata.id,
                turnId,
            });
            const checkpointId = await value.session.appendCustomEntry(WorkspaceControlCustomTypes.checkpoint, {
                schemaVersion: 1,
                status: "available",
                originSessionId: value.metadata.id,
                turnId,
                workspaceIdentity: value.identity.workspaceIdentity,
                workspaceIncarnation: value.identity.workspaceIncarnation,
                before: before.ref,
                after: after.after,
                changes: after.changes,
                coverage: after.coverage,
            } satisfies WorkspaceCheckpointV1);
            if (mode === "force-drift") {
                await writeFile(join(value.workspaceRoot, "b.txt"), "confirmed force drift");
            }
            const preview = await value.engine.previewRewind({
                session: value.session,
                sessionId: value.metadata.id,
                workspace: value.identity,
                semanticLeafId: checkpointId,
                targetTurnId: turnId,
            });

            await expect(
                value.engine.applyRewind({
                    session: value.session,
                    sessionId: value.metadata.id,
                    workspace: value.identity,
                    semanticLeafId: checkpointId,
                    targetTurnId: turnId,
                    mode,
                    confirmation: value.confirmations.take(preview.confirmationToken!),
                })
            ).rejects.toBeInstanceOf(WorkspaceFrozenError);

            expect(await readFile(join(value.workspaceRoot, "a.txt"), "utf8")).toBe("before a");
            expect(await readFile(join(value.workspaceRoot, "b.txt"), "utf8")).toBe("third party");
            expect(await value.session.getLeafId()).toBe(checkpointId);
            expect(value.published).not.toHaveBeenCalled();
            await expect(value.pending.readLocked()).resolves.toMatchObject({
                kind: "valid",
                record: { applyMode: mode },
            });
            await expect(value.recovery.inspectPending()).resolves.toMatchObject({
                state: "needs-user",
                view: {
                    paths: expect.arrayContaining([
                        { path: "a.txt", classification: "target" },
                        { path: "b.txt", classification: "unknown" },
                    ]),
                },
            });
        },
        30_000
    );

    it("detects an external writer after result capture but before the final target verification", async () => {
        const value = await fixture({
            verifyPath: (workspaceRoot) => async (input) => {
                await verifyCapturedPath(input);
                await writeFile(join(workspaceRoot, input.path), "external-writer-after-result-capture");
            },
        });
        const file = join(value.workspaceRoot, "file.txt");
        await writeFile(file, "before");
        const item = await appendAvailableCheckpoint(value, "change file", async () => {
            await writeFile(file, "after");
        });
        const planned = await value.engine.previewRewind({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.identity,
            semanticLeafId: item.checkpointId,
            targetTurnId: item.turnId,
        });

        await expect(
            value.engine.applyRewind({
                session: value.session,
                sessionId: value.metadata.id,
                workspace: value.identity,
                semanticLeafId: item.checkpointId,
                targetTurnId: item.turnId,
                mode: "normal",
                confirmation: value.confirmations.take(planned.confirmationToken!),
            })
        ).rejects.toBeInstanceOf(WorkspaceFrozenError);

        expect(await readFile(file, "utf8")).toBe("external-writer-after-result-capture");
        await expect(value.pending.readLocked()).resolves.toMatchObject({ kind: "valid" });
        await expect(value.recovery.inspectPending()).resolves.toMatchObject({
            state: "needs-user",
            view: { paths: [{ path: "file.txt", classification: "unknown" }] },
        });
    }, 30_000);

    it("retries committed pending cleanup before returning to the next owning-session mutation", async () => {
        const value = await fixture();
        const file = join(value.workspaceRoot, "cleanup.txt");
        await writeFile(file, "before");
        const item = await appendAvailableCheckpoint(value, "change cleanup file", async () => {
            await writeFile(file, "after");
        });
        const planned = await value.engine.previewRewind({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.identity,
            semanticLeafId: item.checkpointId,
            targetTurnId: item.turnId,
        });
        vi.spyOn(value.pending, "removeLocked").mockRejectedValueOnce(new Error("pending cleanup failed"));

        await expect(
            value.engine.applyRewind({
                session: value.session,
                sessionId: value.metadata.id,
                workspace: value.identity,
                semanticLeafId: item.checkpointId,
                targetTurnId: item.turnId,
                mode: "normal",
                confirmation: value.confirmations.take(planned.confirmationToken!),
            })
        ).resolves.toBeDefined();
        const markerLeaf = await value.session.getLeafId();
        await expect(value.pending.readLocked()).resolves.toEqual({ kind: "none" });

        const nextLeaf = await value.session.appendMessage({
            role: "assistant",
            content: "next owning-session mutation",
            timestamp: Date.now(),
        } as never);
        expect(await value.session.getLeafId()).toBe(nextLeaf);
        expect(await readFile(file, "utf8")).toBe("before");
    }, 30_000);

    it("keeps a missing owning Session frozen without changing workspace bytes or the Session tree", async () => {
        const value = await fixture({
            locateSession: async () => undefined,
        });
        const file = join(value.workspaceRoot, "missing-owner.txt");
        await writeFile(file, "before");
        const item = await appendAvailableCheckpoint(value, "change before owner disappears", async () => {
            await writeFile(file, "after");
        });
        const planned = await value.engine.previewRewind({
            session: value.session,
            sessionId: value.metadata.id,
            workspace: value.identity,
            semanticLeafId: item.checkpointId,
            targetTurnId: item.turnId,
        });

        await expect(
            value.engine.applyRewind({
                session: value.session,
                sessionId: value.metadata.id,
                workspace: value.identity,
                semanticLeafId: item.checkpointId,
                targetTurnId: item.turnId,
                mode: "normal",
                confirmation: value.confirmations.take(planned.confirmationToken!),
            })
        ).rejects.toBeInstanceOf(WorkspaceFrozenError);
        const pending = await value.pending.readLocked();
        expect(pending).toMatchObject({ kind: "valid" });
        if (pending.kind !== "valid") throw new Error("expected valid pending restore");
        const leafBefore = await value.session.getLeafId();
        const bytesBefore = await readFile(file);

        await expect(value.recovery.inspectPending()).resolves.toMatchObject({
            state: "needs-user",
            view: { operationId: pending.record.operationId, allowedActions: ["retry"] },
        });
        await expect(value.recovery.resolvePending(pending.record.operationId)).resolves.toMatchObject({
            state: "needs-user",
            view: { operationId: pending.record.operationId, allowedActions: ["retry"] },
        });

        expect(await value.session.getLeafId()).toBe(leafBefore);
        expect(await readFile(file)).toEqual(bytesBefore);
        await expect(value.pending.readLocked()).resolves.toMatchObject({
            kind: "valid",
            record: { operationId: pending.record.operationId },
        });
    }, 30_000);
});

class BoundaryChangeFeed implements WorkspaceChangeFeed {
    paths: string[] = [];
    trusted = false;

    record(paths: readonly string[]): void {
        this.paths = [...new Set([...this.paths, ...paths])].sort((left, right) =>
            Buffer.compare(Buffer.from(left), Buffer.from(right))
        );
    }

    async start(): Promise<void> {
        this.trusted = true;
        this.paths = [];
    }

    async drain(): Promise<WorkspaceChangeDrain> {
        if (!this.trusted) return { status: "unavailable", reason: "not-started" };
        const changedPaths = [...this.paths];
        this.paths = [];
        return { status: "complete", changedPaths };
    }

    isTrusted(): boolean {
        return this.trusted;
    }

    async dispose(): Promise<void> {
        this.trusted = false;
    }
}
