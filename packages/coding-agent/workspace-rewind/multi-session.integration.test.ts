// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { SqliteSessionRepo } from "@crest/agent/harness/session/sqlite-repo";
import type { Session } from "@crest/agent/harness/types";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RewindConfirmationRegistry } from "./confirmation-token";
import { applyCapturedPath } from "./filesystem-apply";
import { WorkspaceGitRunner } from "./git-runner";
import { WorkspaceRecoveryJournal } from "./recovery-journal";
import { WorkspaceRewindEngine, type WorkspaceRewindEngineOptions } from "./rewind-engine";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import { WorkspaceControlCustomTypes, type WorkspaceCheckpointV1 } from "./types";
import type { CanonicalWorkspaceIdentity } from "./workspace-identity";
import { WorkspaceFrozenError, WorkspaceRecovery } from "./workspace-recovery";

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

async function makeFixture(
    options: {
        applyPath?: NonNullable<WorkspaceRewindEngineOptions["applyPath"]>;
    } = {}
) {
    const root = await mkdtemp(join(tmpdir(), "crest-rewind-multi-session-"));
    cleanupRoots.push(root);
    const workspaceRoot = await realpath(await mkdir(join(root, "workspace"), { recursive: true }));
    const identity: CanonicalWorkspaceIdentity = {
        canonicalRoot: workspaceRoot,
        workspaceIdentity: "1".repeat(64),
        workspaceIncarnation: "2".repeat(64),
        storeKey: "multi-session-integration",
        ancestorIdentityChain: await ancestorIdentityChain(workspaceRoot),
    };
    const store = await WorkspaceSnapshotStore.open({
        dataRoot: join(root, "data"),
        identity,
        git: new WorkspaceGitRunner(),
        processOwner: {
            pid: process.pid,
            processStartToken: "multi-session-integration",
            nonce: "3".repeat(64),
        },
    });
    const repo = new SqliteSessionRepo({ sessionsRoot: join(root, "sessions") });
    const sessions = {
        a: await repo.create({ cwd: workspaceRoot, id: "session-a" }),
        b: await repo.create({ cwd: workspaceRoot, id: "session-b" }),
    };
    const confirmations = new RewindConfirmationRegistry();
    const journal = new WorkspaceRecoveryJournal(store);
    const published = vi.fn(async () => {});
    const locateSession = async (sessionId: string) =>
        sessionId === "session-a" ? sessions.a : sessionId === "session-b" ? sessions.b : undefined;
    const recovery = new WorkspaceRecovery({
        workspace: identity,
        store,
        journal,
        locateSession,
        publishState: published,
        repairSessionRefs: vi.fn(async () => {}),
        verifyWorkspace: vi.fn(async () => {}),
    });
    const engine = new WorkspaceRewindEngine({
        store,
        journal,
        recovery,
        confirmations,
        onCommitted: published,
        ...(options.applyPath ? { applyPath: options.applyPath } : {}),
    });
    return { root, workspaceRoot, identity, store, sessions, confirmations, journal, recovery, engine };
}

async function checkpoint(
    value: Awaited<ReturnType<typeof makeFixture>>,
    session: Session,
    prompt: string,
    mutate: () => Promise<void>
) {
    const before = await value.store.capture({ profile: "pre-turn" });
    const turnId = await session.appendMessage({ role: "user", content: prompt, timestamp: Date.now() } as never);
    await mutate();
    const after = await value.store.capture({ profile: "terminal" });
    const metadata = await session.getMetadata();
    const data: WorkspaceCheckpointV1 = {
        schemaVersion: 1,
        status: "available",
        originSessionId: metadata.id,
        turnId,
        workspaceIdentity: value.identity.workspaceIdentity,
        workspaceIncarnation: value.identity.workspaceIncarnation,
        before: before.ref,
        after: after.ref,
        changes: await value.store.diff(before.ref, after.ref),
        coverage: after.coverage,
    };
    const checkpointId = await session.appendCustomEntry(WorkspaceControlCustomTypes.checkpoint, data);
    return { turnId, checkpointId, metadata };
}

async function preview(value: Awaited<ReturnType<typeof makeFixture>>, item: Awaited<ReturnType<typeof checkpoint>>) {
    return value.engine.previewRewind({
        session: item.metadata.id === "session-a" ? value.sessions.a : value.sessions.b,
        sessionId: item.metadata.id,
        workspace: value.identity,
        semanticLeafId: item.checkpointId,
        targetTurnId: item.turnId,
    });
}

describe("workspace rewind across sessions", () => {
    it("turn Undo in session A restores only A's disjoint path and leaves session B bytes intact", async () => {
        const value = await makeFixture();
        await writeFile(join(value.workspaceRoot, "a.txt"), "base-a");
        await writeFile(join(value.workspaceRoot, "b.txt"), "base-b");
        const a = await checkpoint(value, value.sessions.a, "change a", async () => {
            await writeFile(join(value.workspaceRoot, "a.txt"), "session-a");
        });
        await checkpoint(value, value.sessions.b, "change b", async () => {
            await writeFile(join(value.workspaceRoot, "b.txt"), "session-b");
        });

        const planned = await value.engine.previewTurnUndo({
            session: value.sessions.a,
            sessionId: a.metadata.id,
            workspace: value.identity,
            semanticLeafId: a.checkpointId,
            sourceTurnId: a.turnId,
        });
        expect(planned.files.map((file) => file.path)).toEqual(["a.txt"]);
        await value.engine.applyTurnUndo({
            session: value.sessions.a,
            sessionId: a.metadata.id,
            workspace: value.identity,
            semanticLeafId: a.checkpointId,
            sourceTurnId: a.turnId,
            mode: "normal",
            confirmation: value.confirmations.take(planned.confirmationToken!),
        });

        expect(await readFile(join(value.workspaceRoot, "a.txt"), "utf8")).toBe("base-a");
        expect(await readFile(join(value.workspaceRoot, "b.txt"), "utf8")).toBe("session-b");
    }, 30_000);

    it("blocks normal turn Undo when another session replaced the same path", async () => {
        const value = await makeFixture();
        await writeFile(join(value.workspaceRoot, "shared.txt"), "base");
        const a = await checkpoint(value, value.sessions.a, "change shared in A", async () => {
            await writeFile(join(value.workspaceRoot, "shared.txt"), "session-a");
        });
        await checkpoint(value, value.sessions.b, "change shared in B", async () => {
            await writeFile(join(value.workspaceRoot, "shared.txt"), "session-b");
        });

        const planned = await value.engine.previewTurnUndo({
            session: value.sessions.a,
            sessionId: a.metadata.id,
            workspace: value.identity,
            semanticLeafId: a.checkpointId,
            sourceTurnId: a.turnId,
        });
        expect(planned).toMatchObject({ forceRequired: true, hardBlocked: false });
        expect(planned.files).toEqual([expect.objectContaining({ path: "shared.txt", conflict: "forceable-drift" })]);
        await expect(
            value.engine.applyTurnUndo({
                session: value.sessions.a,
                sessionId: a.metadata.id,
                workspace: value.identity,
                semanticLeafId: a.checkpointId,
                sourceTurnId: a.turnId,
                mode: "normal",
                confirmation: value.confirmations.take(planned.confirmationToken!),
            })
        ).rejects.toThrow(/force/i);
        expect(await readFile(join(value.workspaceRoot, "shared.txt"), "utf8")).toBe("session-b");
    }, 30_000);

    it("rewinds only session A paths while preserving later session B bytes", async () => {
        const value = await makeFixture();
        await writeFile(join(value.workspaceRoot, "a.txt"), "base-a");
        await writeFile(join(value.workspaceRoot, "b.txt"), "base-b");
        const a = await checkpoint(value, value.sessions.a, "change a", async () => {
            await writeFile(join(value.workspaceRoot, "a.txt"), "session-a");
        });
        await checkpoint(value, value.sessions.b, "change b", async () => {
            await writeFile(join(value.workspaceRoot, "b.txt"), "session-b");
        });

        const planned = await preview(value, a);
        expect(planned.files.map((file) => file.path)).toEqual(["a.txt"]);
        await value.engine.applyRewind({
            session: value.sessions.a,
            sessionId: a.metadata.id,
            workspace: value.identity,
            semanticLeafId: a.checkpointId,
            targetTurnId: a.turnId,
            mode: "normal",
            confirmation: value.confirmations.take(planned.confirmationToken!),
        });

        expect(await readFile(join(value.workspaceRoot, "a.txt"), "utf8")).toBe("base-a");
        expect(await readFile(join(value.workspaceRoot, "b.txt"), "utf8")).toBe("session-b");
    }, 30_000);

    it("requires Force for overlapping later writes and overwrites only the confirmed red-list", async () => {
        const value = await makeFixture();
        await writeFile(join(value.workspaceRoot, "shared.txt"), "base");
        await writeFile(join(value.workspaceRoot, "b-only.txt"), "base-b");
        const a = await checkpoint(value, value.sessions.a, "change shared", async () => {
            await writeFile(join(value.workspaceRoot, "shared.txt"), "session-a");
        });
        await checkpoint(value, value.sessions.b, "change shared and private", async () => {
            await writeFile(join(value.workspaceRoot, "shared.txt"), "session-b");
            await writeFile(join(value.workspaceRoot, "b-only.txt"), "session-b-only");
        });

        const normalPreview = await preview(value, a);
        expect(normalPreview.forceRequired).toBe(true);
        expect(normalPreview.files).toEqual([
            expect.objectContaining({ path: "shared.txt", conflict: "forceable-drift" }),
        ]);
        const beforeNormal = {
            shared: await readFile(join(value.workspaceRoot, "shared.txt"), "utf8"),
            private: await readFile(join(value.workspaceRoot, "b-only.txt"), "utf8"),
        };
        await expect(
            value.engine.applyRewind({
                session: value.sessions.a,
                sessionId: a.metadata.id,
                workspace: value.identity,
                semanticLeafId: a.checkpointId,
                targetTurnId: a.turnId,
                mode: "normal",
                confirmation: value.confirmations.take(normalPreview.confirmationToken!),
            })
        ).rejects.toThrow(/force/i);
        expect(await readFile(join(value.workspaceRoot, "shared.txt"), "utf8")).toBe(beforeNormal.shared);
        expect(await readFile(join(value.workspaceRoot, "b-only.txt"), "utf8")).toBe(beforeNormal.private);

        const forcePreview = await preview(value, a);
        await value.engine.applyRewind({
            session: value.sessions.a,
            sessionId: a.metadata.id,
            workspace: value.identity,
            semanticLeafId: a.checkpointId,
            targetTurnId: a.turnId,
            mode: "force-drift",
            confirmation: value.confirmations.take(forcePreview.confirmationToken!),
        });
        expect(await readFile(join(value.workspaceRoot, "shared.txt"), "utf8")).toBe("base");
        expect(await readFile(join(value.workspaceRoot, "b-only.txt"), "utf8")).toBe("session-b-only");
    }, 30_000);

    it("rejects a stale preview token after another session writes without mutating either path", async () => {
        const value = await makeFixture();
        await writeFile(join(value.workspaceRoot, "shared.txt"), "base");
        await writeFile(join(value.workspaceRoot, "untouched.txt"), "untouched");
        const a = await checkpoint(value, value.sessions.a, "change shared", async () => {
            await writeFile(join(value.workspaceRoot, "shared.txt"), "session-a");
        });
        const planned = await preview(value, a);
        await writeFile(join(value.workspaceRoot, "shared.txt"), "session-b-after-preview");

        await expect(
            value.engine.applyRewind({
                session: value.sessions.a,
                sessionId: a.metadata.id,
                workspace: value.identity,
                semanticLeafId: a.checkpointId,
                targetTurnId: a.turnId,
                mode: "force-drift",
                confirmation: value.confirmations.take(planned.confirmationToken!),
            })
        ).rejects.toThrow(/confirmation|changed|plan/i);
        expect(await readFile(join(value.workspaceRoot, "shared.txt"), "utf8")).toBe("session-b-after-preview");
        expect(await readFile(join(value.workspaceRoot, "untouched.txt"), "utf8")).toBe("untouched");
    }, 30_000);

    it("freezes recovery when an unknown writer changes bytes after final verification", async () => {
        let value: Awaited<ReturnType<typeof makeFixture>>;
        value = await makeFixture({
            applyPath: async (input) => {
                await applyCapturedPath(input);
                await writeFile(join(value.workspaceRoot, input.path), "unknown-third-party");
            },
        });
        await writeFile(join(value.workspaceRoot, "shared.txt"), "base");
        const a = await checkpoint(value, value.sessions.a, "change shared", async () => {
            await writeFile(join(value.workspaceRoot, "shared.txt"), "after");
        });
        const planned = await preview(value, a);

        await expect(
            value.engine.applyRewind({
                session: value.sessions.a,
                sessionId: a.metadata.id,
                workspace: value.identity,
                semanticLeafId: a.checkpointId,
                targetTurnId: a.turnId,
                mode: "normal",
                confirmation: value.confirmations.take(planned.confirmationToken!),
            })
        ).rejects.toBeInstanceOf(WorkspaceFrozenError);
        expect(await readFile(join(value.workspaceRoot, "shared.txt"), "utf8")).toBe("unknown-third-party");
        expect(await value.recovery.getRecoveryState(value.identity)).toMatchObject({
            paths: [{ path: "shared.txt", classification: "unknown" }],
            allowedActions: ["retry", "abandon-current"],
        });
    }, 30_000);
});
