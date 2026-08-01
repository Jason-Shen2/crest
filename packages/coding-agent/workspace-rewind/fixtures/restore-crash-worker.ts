// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdir, open, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { SqliteSessionStorage } from "@crest/agent/harness/session/sqlite-storage";
import type { SessionTreeEntry } from "@crest/agent/harness/types";
import { writeDurableJson } from "../durability";
import { applyCapturedPath } from "../filesystem-apply";
import { WorkspaceGitRunner } from "../git-runner";
import { makeProcessOwnerIdentity } from "../process-owner";
import {
    WorkspaceRecoveryJournal,
    type WorkspaceOperationJournalV2,
    type WorkspaceRecoveryJournalBoundary,
} from "../recovery-journal";
import { WorkspaceSnapshotStore } from "../snapshot-store";
import { WorkspaceControlCustomTypes, type CapturedPathStateV1, type WorkspaceSnapshotRefV1 } from "../types";
import type { CanonicalWorkspaceIdentity, WorkspaceDirectoryIdentityToken } from "../workspace-identity";
import { workspaceStateFromJournal } from "../workspace-restore-executor";

const Identity = "1".repeat(64);
const Incarnation = "2".repeat(64);
const OperationId = "operation-1";
const SessionId = "session-1";
const Paths = ["first.txt", "second.txt"] as const;
const PreContents = [Buffer.from("pre first"), Buffer.from("pre second")] as const;
const TargetContents = [Buffer.from("target first"), Buffer.from("target second")] as const;

async function main(): Promise<void> {
    const [root, boundary, requestedKind = "rewind"] = process.argv.slice(2);
    if (!root || !boundary) {
        throw new Error("restore crash worker arguments are invalid");
    }
    if (requestedKind !== "rewind" && requestedKind !== "turn-undo" && requestedKind !== "turn-redo") {
        throw new Error("restore crash worker kind is invalid");
    }
    const workspaceRoot = join(root, "workspace");
    const dataRoot = join(root, "data");
    const sessionPath = join(root, "session.db");
    await mkdir(workspaceRoot, { recursive: true });
    const canonicalRoot = await realpath(workspaceRoot);
    const identity: CanonicalWorkspaceIdentity = {
        canonicalRoot,
        workspaceIdentity: Identity,
        workspaceIncarnation: Incarnation,
        storeKey: "restore-crash-store",
        ancestorIdentityChain: await captureAncestorIdentityChain(canonicalRoot),
    };
    const pause = async (value: string) => {
        if (boundary !== value) {
            return;
        }
        process.send?.("ready");
        await new Promise(() => {});
    };
    const store = await WorkspaceSnapshotStore.open({
        dataRoot,
        identity,
        git: new WorkspaceGitRunner(),
        processOwner: await makeProcessOwnerIdentity(),
    });
    for (let index = 0; index < Paths.length; index++) {
        await durableWrite(join(canonicalRoot, Paths[index]!), TargetContents[index]!);
    }
    const resultSnapshot = (await store.capture({ profile: "terminal" })).ref;
    for (let index = 0; index < Paths.length; index++) {
        await durableWrite(join(canonicalRoot, Paths[index]!), PreContents[index]!);
    }
    const safetySnapshot = (await store.capture({ profile: "terminal" })).ref;
    const pathStates = await Promise.all(
        Paths.map(async (path) => ({
            path,
            preState: await store.readPathState(safetySnapshot, path),
            target: await store.readPathState(resultSnapshot, path),
        }))
    );
    const session = SqliteSessionStorage.create(sessionPath, {
        cwd: canonicalRoot,
        sessionId: SessionId,
    });
    await session.appendEntries(initialSessionEntries());
    await writeDurableJson(join(root, "fixture.json"), {
        identity,
        dataRoot,
        sessionPath,
        paths: pathStates,
    });

    const originalAnchorOperation = store.anchorOperation.bind(store);
    store.anchorOperation = async (record) => {
        await pause("operation-ref-before");
        await originalAnchorOperation(record);
        await pause("operation-ref-after");
    };
    const originalDeleteCrestRef = store.deleteCrestRef.bind(store);
    store.deleteCrestRef = async (refName) => {
        await pause("operation-ref-remove-before");
        await originalDeleteCrestRef(refName);
    };
    const journal = new WorkspaceRecoveryJournal(store, {
        onDurableBoundary: async (value: WorkspaceRecoveryJournalBoundary) => {
            await pause(value);
        },
    });
    let record = operation(identity, sessionPath, safetySnapshot, pathStates, requestedKind);

    await journal.begin(record);
    record = await journal.transition(OperationId, "applying_files");
    for (let index = 0; index < pathStates.length; index++) {
        const item = pathStates[index]!;
        const createdParentDirectories = new Set<string>();
        await applyCapturedPath({
            root: canonicalRoot,
            path: item.path,
            expectedCurrent: item.preState,
            target: item.target,
            readBlob: (oid) => store.readBlob(oid),
            progress: {
                operationId: OperationId,
                createdParentDirectories,
                onParentDirectoryCreated: async () => {
                    await journal.updatePathProgress(OperationId, item.path, [...createdParentDirectories]);
                },
                onPathReplaced: async () => {
                    await journal.updatePathProgress(OperationId, item.path, [...createdParentDirectories]);
                    await pause(`path-rename-after-${index}`);
                },
            },
        });
    }
    record = await journal.transition(OperationId, "files_verified", { resultSnapshot });
    record = await journal.transition(OperationId, "committing_session");
    await pause("sqlite-cas-before");
    await session.appendEntries([workspaceStateEntry(record)], {
        expectedLeafId: "old-leaf",
    });
    await pause("sqlite-cas-after");
    await journal.transition(OperationId, "completed");
    await journal.completeCleanup(OperationId);
    process.send?.("completed");
}

function operation(
    identity: CanonicalWorkspaceIdentity,
    sessionPath: string,
    safetySnapshot: WorkspaceSnapshotRefV1,
    paths: Array<{ path: string; preState: CapturedPathStateV1; target: CapturedPathStateV1 }>,
    kind: "rewind" | "turn-undo" | "turn-redo"
): WorkspaceOperationJournalV2 {
    const target =
        kind === "rewind"
            ? ({ kind: "rewind", targetTurnId: "target-turn" } as const)
            : kind === "turn-undo"
              ? ({ kind: "turn-undo", sourceTurnId: "source-turn" } as const)
              : ({
                    kind: "turn-redo",
                    sourceTurnId: "source-turn",
                    undoOperationId: "undo-operation",
                } as const);
    return {
        schemaVersion: 2,
        phase: "prepared",
        workspaceIdentity: identity.workspaceIdentity,
        workspaceIncarnation: identity.workspaceIncarnation,
        sessionId: SessionId,
        sessionPath,
        operationId: OperationId,
        target,
        commitParentId: kind === "rewind" ? "target-boundary" : "old-leaf",
        applyMode: "normal",
        expectedSemanticLeafId: "old-leaf",
        safetySnapshot,
        confirmedConflictFingerprints: [],
        paths: paths.map((item, index) => ({
            ...item,
            expectedCurrent: item.preState,
            confirmedLiveFingerprint: String(index + 3).repeat(64),
            createdParentDirectories: [],
        })),
        workspaceStateEntryId: "operation-leaf",
    };
}

function initialSessionEntries(): SessionTreeEntry[] {
    const timestamp = new Date(0).toISOString();
    return [
        {
            type: "custom",
            id: "target-boundary",
            parentId: null,
            timestamp,
            customType: "restore_crash_boundary",
            data: {},
        },
        {
            type: "custom",
            id: "old-leaf",
            parentId: "target-boundary",
            timestamp,
            customType: "restore_crash_leaf",
            data: {},
        },
    ];
}

function workspaceStateEntry(record: WorkspaceOperationJournalV2): SessionTreeEntry {
    return {
        type: "custom",
        id: "operation-leaf",
        parentId: record.commitParentId,
        timestamp: new Date(1).toISOString(),
        customType: WorkspaceControlCustomTypes.state,
        data: workspaceStateFromJournal(record),
    };
}

async function durableWrite(path: string, bytes: Buffer): Promise<void> {
    const handle = await open(path, "w", 0o600);
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function captureAncestorIdentityChain(path: string): Promise<WorkspaceDirectoryIdentityToken[]> {
    const paths = [path];
    while (true) {
        const parent = dirname(paths[0]!);
        if (parent === paths[0]) {
            break;
        }
        paths.unshift(parent);
    }
    return Promise.all(
        paths.map(async (absolutePath) => {
            const metadata = await stat(absolutePath, { bigint: true });
            return {
                absolutePath,
                dev: metadata.dev.toString(),
                ino: metadata.ino.toString(),
                birthtimeNs: metadata.birthtimeNs.toString(),
            };
        })
    );
}

void main().catch((error) => {
    process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
});
