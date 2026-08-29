// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { encodeDurableJson } from "./durability";
import {
    publishAnchoredJournalEntryNoReplace,
    readAnchoredJournalPublication,
    recoverAnchoredJournalPublication,
    removeAnchoredJournalEntry,
    type AnchoredJournalDirectoryIdentity,
    type AnchoredJournalEntry,
} from "./journal-directory";
import type { RestoreTargetV1 } from "./restore-plan";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import type { WorkspaceLinkedOperationV1 } from "./types";
import { decodeWorkspaceSnapshotRefV1 } from "./validation";

export interface PendingWorkspaceRestoreV2 {
    schemaVersion: 2;
    operationId: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    sessionId: string;
    sessionPath: string;
    target: RestoreTargetV1;
    applyMode: "normal" | "force-drift";
    forcedPaths: string[];
    expectedSemanticLeafId: string | null;
    commitParentId: string | null;
    workspaceStateEntryId: string;
    workspaceStateTimestamp: string;
    sourceCommit: string;
    plannedCommit: string;
    affectedPaths: string[];
}

export type ScannedPendingWorkspaceRestore =
    | { kind: "none" }
    | { kind: "valid"; record: PendingWorkspaceRestoreV2 }
    | { kind: "corrupt"; operationId: string; message: string; bytes: Buffer };

const TokenPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IdentityPattern = /^[0-9a-f]{64}$/;
const OidPattern = /^[0-9a-f]{40}$/;
const MaximumPendingBytes = 4 * 1024 * 1024;
const MaximumRestorePaths = 4_096;

export class PendingWorkspaceRestoreStore {
    readonly store: WorkspaceSnapshotStore;
    readonly root: string;
    rootIdentity?: AnchoredJournalDirectoryIdentity;
    published?: { operationId: string; source: AnchoredJournalEntry };

    constructor(store: WorkspaceSnapshotStore) {
        if (!isAbsolute(store.storeRoot)) {
            throw new Error("Pending restore store root must be absolute");
        }
        this.store = store;
        this.root = join(store.storeRoot, "journal", "restore");
    }

    readCandidate(): Promise<ScannedPendingWorkspaceRestore> {
        return this.scanActive(false);
    }

    inspectLocked(): Promise<ScannedPendingWorkspaceRestore> {
        return this.scanActive(false);
    }

    readLocked(): Promise<ScannedPendingWorkspaceRestore> {
        return this.scanActive(true);
    }

    async publishLocked(record: PendingWorkspaceRestoreV2): Promise<void> {
        const decoded = decodePendingWorkspaceRestoreV2(record);
        if (!decoded) {
            throw new Error("Invalid pending workspace restore");
        }
        this.assertIdentity(decoded);
        await this.validateCommitFacts(decoded);
        await this.publishDecodedLocked(decoded);
    }

    async publishPreparedLocked(record: PendingWorkspaceRestoreV2): Promise<void> {
        const decoded = decodePendingWorkspaceRestoreV2(record);
        if (!decoded) {
            throw new Error("Invalid pending workspace restore");
        }
        this.assertIdentity(decoded);
        await this.publishDecodedLocked(decoded);
    }

    async publishDecodedLocked(decoded: PendingWorkspaceRestoreV2): Promise<void> {
        const identity = await makePrivateDirectory(this.root);
        if (this.rootIdentity && !sameIdentity(this.rootIdentity, identity)) {
            throw new Error("Pending restore directory identity changed");
        }
        this.rootIdentity ??= identity;
        try {
            const bytes = encodeDurableJson(decoded);
            const entryIdentity = await publishAnchoredJournalEntryNoReplace({
                root: this.root,
                rootIdentity: identity,
                destinationName: "pending.json",
                bytes,
            });
            this.published = {
                operationId: decoded.operationId,
                source: { name: "pending.json", bytes, identity: entryIdentity },
            };
        } catch (error) {
            if (error instanceof Error && /journal write destination appeared/i.test(error.message)) {
                throw new Error("A workspace restore is already pending", { cause: error });
            }
            throw error;
        }
    }

    async removeLocked(operationId: string): Promise<void> {
        validateToken(operationId);
        if (this.published?.operationId === operationId && this.rootIdentity) {
            await removeAnchoredJournalEntry({
                root: this.root,
                rootIdentity: this.rootIdentity,
                source: this.published.source,
            });
            this.published = undefined;
            return;
        }
        const { rootIdentity, source, record } = await this.requireValidActive();
        if (record.operationId !== operationId) {
            throw new Error("Pending restore belongs to another operation");
        }
        await removeAnchoredJournalEntry({ root: this.root, rootIdentity, source });
    }

    async scanActive(recoverPublication: boolean): Promise<ScannedPendingWorkspaceRestore> {
        const source = (await this.readActiveEntry(recoverPublication))?.source;
        if (!source) {
            return { kind: "none" };
        }
        return decodeCandidate(source.bytes, this.store);
    }

    async requireValidActive(): Promise<{
        rootIdentity: AnchoredJournalDirectoryIdentity;
        source: AnchoredJournalEntry;
        record: PendingWorkspaceRestoreV2;
    }> {
        const active = await this.readActiveEntry(true);
        if (!active?.source) {
            throw new Error("No workspace restore is pending");
        }
        const source = active.source;
        const candidate = decodeCandidate(source.bytes, this.store);
        if (candidate.kind !== "valid") {
            throw new Error(`Pending workspace restore is corrupt: ${candidate.message}`);
        }
        return { rootIdentity: active.identity, source, record: candidate.record };
    }

    async readActiveEntry(
        recoverPublication = false
    ): Promise<{ identity: AnchoredJournalDirectoryIdentity; source?: AnchoredJournalEntry } | undefined> {
        const active = await (recoverPublication ? recoverAnchoredJournalPublication : readAnchoredJournalPublication)({
            root: this.root,
            destinationName: "pending.json",
            maximumEntryBytes: MaximumPendingBytes,
        });
        if (!active) {
            if (this.rootIdentity) {
                throw new Error("Pending restore directory disappeared");
            }
            return undefined;
        }
        if (this.rootIdentity && !sameIdentity(this.rootIdentity, active.identity)) {
            throw new Error("Pending restore directory identity changed");
        }
        this.rootIdentity ??= active.identity;
        return { identity: active.identity, ...(active.entry ? { source: active.entry } : {}) };
    }

    assertIdentity(record: PendingWorkspaceRestoreV2): void {
        if (
            record.workspaceIdentity !== this.store.identity.workspaceIdentity ||
            record.workspaceIncarnation !== this.store.identity.workspaceIncarnation
        ) {
            throw new Error("Pending restore belongs to another workspace incarnation");
        }
    }

    async validateCommitFacts(record: PendingWorkspaceRestoreV2): Promise<void> {
        const [, , changedPaths] = await Promise.all([
            this.store.readCommitSnapshot(record.sourceCommit),
            this.store.readCommitSnapshot(record.plannedCommit),
            this.store.mutationLog.changedPaths(record.plannedCommit),
        ]);
        const planned = await this.store.mutationLog.read(record.plannedCommit);
        const expectedTurnId = turnIdFor(record.target);
        const expectedSourceOperationId = sourceOperationIdFor(record.target);
        const linkedOperation = linkedOperationFor(record.target);
        if (
            planned.parent !== record.sourceCommit ||
            planned.metadata.kind !== record.target.kind ||
            planned.metadata.sessionid !== record.sessionId ||
            planned.metadata.operationid !== record.operationId ||
            planned.metadata.turnid !== expectedTurnId ||
            planned.metadata.sourceoperationid !== expectedSourceOperationId ||
            planned.metadata.linkedresultcommitid !== linkedOperation?.currentSnapshot.id
        ) {
            throw new Error("Pending restore result commit does not match its operation");
        }
        if (!samePaths(changedPaths, record.affectedPaths)) {
            throw new Error("Pending restore paths do not match the result commit");
        }
        if (linkedOperation) {
            const [sourceSnapshot, currentSnapshot, sourceResult] = await Promise.all([
                this.store.readCommitSnapshot(linkedOperation.sourceSnapshot.id),
                this.store.readCommitSnapshot(linkedOperation.currentSnapshot.id),
                this.store.mutationLog.read(linkedOperation.currentSnapshot.id),
            ]);
            const expectedKind = record.target.kind === "redo" ? "rewind" : "turn-undo";
            if (
                linkedOperation.operationId !== expectedSourceOperationId ||
                !isDeepStrictEqual(sourceSnapshot, linkedOperation.sourceSnapshot) ||
                !isDeepStrictEqual(currentSnapshot, linkedOperation.currentSnapshot) ||
                sourceResult.parent !== linkedOperation.sourceSnapshot.id ||
                sourceResult.tree !== linkedOperation.currentSnapshot.tree ||
                sourceResult.metadata.kind !== expectedKind ||
                sourceResult.metadata.sessionid !== record.sessionId ||
                sourceResult.metadata.operationid !== linkedOperation.operationId ||
                (record.target.kind === "turn-redo" && sourceResult.metadata.turnid !== record.target.sourceTurnId)
            ) {
                throw new Error("Pending restore linked result does not match its source operation");
            }
        }
    }
}

export function decodePendingWorkspaceRestoreV2(value: unknown): PendingWorkspaceRestoreV2 | undefined {
    if (
        !isRecord(value) ||
        !hasExactKeys(value, [
            "schemaVersion",
            "operationId",
            "workspaceIdentity",
            "workspaceIncarnation",
            "sessionId",
            "sessionPath",
            "target",
            "applyMode",
            "forcedPaths",
            "expectedSemanticLeafId",
            "commitParentId",
            "workspaceStateEntryId",
            "workspaceStateTimestamp",
            "sourceCommit",
            "plannedCommit",
            "affectedPaths",
        ]) ||
        value.schemaVersion !== 2 ||
        !TokenPattern.test(String(value.operationId ?? "")) ||
        !isIdentity(value.workspaceIdentity) ||
        !isIdentity(value.workspaceIncarnation) ||
        !isSafeString(value.sessionId) ||
        !isAbsoluteSafePath(value.sessionPath) ||
        (value.expectedSemanticLeafId != null && !isSafeString(value.expectedSemanticLeafId)) ||
        (value.commitParentId != null && !isSafeString(value.commitParentId)) ||
        !isSafeString(value.workspaceStateEntryId) ||
        !isCanonicalTimestamp(value.workspaceStateTimestamp) ||
        !isOid(value.sourceCommit) ||
        !isOid(value.plannedCommit) ||
        value.sourceCommit === value.plannedCommit ||
        (value.applyMode !== "normal" && value.applyMode !== "force-drift") ||
        !Array.isArray(value.forcedPaths) ||
        !Array.isArray(value.affectedPaths) ||
        value.affectedPaths.length > MaximumRestorePaths
    ) {
        return undefined;
    }
    const target = decodeRestoreTargetV1(value.target);
    if (!target) {
        return undefined;
    }
    if (value.applyMode === "force-drift" && target.kind !== "rewind" && target.kind !== "turn-undo") {
        return undefined;
    }
    const affectedPaths = value.affectedPaths as unknown[];
    const forcedPaths = value.forcedPaths as unknown[];
    if (
        !affectedPaths.every(isCanonicalRelativePath) ||
        !isSortedUnique(affectedPaths as string[]) ||
        !forcedPaths.every(isCanonicalRelativePath) ||
        !isSortedUnique(forcedPaths as string[]) ||
        (forcedPaths as string[]).some((path) => !(affectedPaths as string[]).includes(path)) ||
        (value.applyMode === "normal" && forcedPaths.length > 0)
    ) {
        return undefined;
    }
    return {
        schemaVersion: 2,
        operationId: value.operationId as string,
        workspaceIdentity: value.workspaceIdentity as string,
        workspaceIncarnation: value.workspaceIncarnation as string,
        sessionId: value.sessionId as string,
        sessionPath: value.sessionPath as string,
        target,
        applyMode: value.applyMode,
        forcedPaths: [...(value.forcedPaths as string[])],
        expectedSemanticLeafId: value.expectedSemanticLeafId as string | null,
        commitParentId: value.commitParentId as string | null,
        workspaceStateEntryId: value.workspaceStateEntryId as string,
        workspaceStateTimestamp: value.workspaceStateTimestamp as string,
        sourceCommit: value.sourceCommit as string,
        plannedCommit: value.plannedCommit as string,
        affectedPaths: [...(value.affectedPaths as string[])],
    };
}

function decodeRestoreTargetV1(value: unknown): RestoreTargetV1 | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (value.kind === "rewind" && hasExactKeys(value, ["kind", "targetTurnId"]) && isSafeString(value.targetTurnId)) {
        return { kind: "rewind", targetTurnId: value.targetTurnId };
    }
    if (
        value.kind === "redo" &&
        hasExactKeys(value, ["kind", "sourceRewindOperationId", "linkedOperation"]) &&
        isSafeString(value.sourceRewindOperationId)
    ) {
        const linkedOperation = decodeLinkedOperation(value.linkedOperation);
        return linkedOperation?.operationId === value.sourceRewindOperationId
            ? { kind: "redo", sourceRewindOperationId: value.sourceRewindOperationId, linkedOperation }
            : undefined;
    }
    if (
        value.kind === "turn-undo" &&
        hasExactKeys(value, ["kind", "sourceTurnId"]) &&
        isSafeString(value.sourceTurnId)
    ) {
        return { kind: "turn-undo", sourceTurnId: value.sourceTurnId };
    }
    if (
        value.kind === "turn-redo" &&
        hasExactKeys(value, ["kind", "sourceTurnId", "undoOperationId", "linkedOperation"]) &&
        isSafeString(value.sourceTurnId) &&
        isSafeString(value.undoOperationId)
    ) {
        const linkedOperation = decodeLinkedOperation(value.linkedOperation);
        return linkedOperation?.operationId === value.undoOperationId
            ? {
                  kind: "turn-redo",
                  sourceTurnId: value.sourceTurnId,
                  undoOperationId: value.undoOperationId,
                  linkedOperation,
              }
            : undefined;
    }
    return undefined;
}

function decodeCandidate(
    bytes: Buffer,
    store: WorkspaceSnapshotStore
): Exclude<ScannedPendingWorkspaceRestore, { kind: "none" }> {
    let value: unknown;
    try {
        value = JSON.parse(bytes.toString("utf8"));
    } catch {
        return corruptCandidate(bytes, "Pending workspace restore is not valid JSON");
    }
    const record = decodePendingWorkspaceRestoreV2(value);
    if (!record || !bytes.equals(encodeDurableJson(record))) {
        return corruptCandidate(bytes, "Pending workspace restore is not canonical or has an incompatible schema");
    }
    if (
        record.workspaceIdentity !== store.identity.workspaceIdentity ||
        record.workspaceIncarnation !== store.identity.workspaceIncarnation
    ) {
        return {
            kind: "corrupt",
            operationId: record.operationId,
            message: "Pending workspace restore belongs to another workspace incarnation",
            bytes,
        };
    }
    return { kind: "valid", record };
}

function corruptCandidate(
    bytes: Buffer,
    message: string
): Extract<ScannedPendingWorkspaceRestore, { kind: "corrupt" }> {
    const matched = /"operationId"\s*:\s*"([^"\\]*)"/.exec(bytes.toString("utf8"))?.[1];
    const operationId =
        matched && TokenPattern.test(matched) ? matched : `corrupt-${createHash("sha1").update(bytes).digest("hex")}`;
    return { kind: "corrupt", operationId, message, bytes };
}

function turnIdFor(target: RestoreTargetV1): string | undefined {
    if (target.kind === "rewind") return target.targetTurnId;
    if (target.kind === "turn-undo" || target.kind === "turn-redo") return target.sourceTurnId;
    return undefined;
}

function sourceOperationIdFor(target: RestoreTargetV1): string | undefined {
    if (target.kind === "redo") return target.sourceRewindOperationId;
    if (target.kind === "turn-redo") return target.undoOperationId;
    return undefined;
}

function linkedOperationFor(target: RestoreTargetV1): WorkspaceLinkedOperationV1 | undefined {
    return target.kind === "redo" || target.kind === "turn-redo" ? target.linkedOperation : undefined;
}

function decodeLinkedOperation(value: unknown): WorkspaceLinkedOperationV1 | undefined {
    if (!isRecord(value) || !hasExactKeys(value, ["operationId", "sourceSnapshot", "currentSnapshot"])) {
        return undefined;
    }
    const sourceSnapshot = decodeWorkspaceSnapshotRefV1(value.sourceSnapshot);
    const currentSnapshot = decodeWorkspaceSnapshotRefV1(value.currentSnapshot);
    if (
        !isSafeString(value.operationId) ||
        !sourceSnapshot ||
        !currentSnapshot ||
        sourceSnapshot.id === currentSnapshot.id ||
        sourceSnapshot.workspaceIdentity !== currentSnapshot.workspaceIdentity ||
        sourceSnapshot.workspaceIncarnation !== currentSnapshot.workspaceIncarnation
    ) {
        return undefined;
    }
    return { operationId: value.operationId, sourceSnapshot, currentSnapshot };
}

function isCanonicalRelativePath(path: unknown): path is string {
    return (
        typeof path === "string" &&
        path.length > 0 &&
        path.length <= 4_096 &&
        hasWellFormedUtf16(path) &&
        !path.includes("\0") &&
        !path.includes("\\") &&
        !path.startsWith("/") &&
        !/^[A-Za-z]:/.test(path) &&
        path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    );
}

function isAbsoluteSafePath(path: unknown): path is string {
    return (
        typeof path === "string" &&
        isAbsolute(path) &&
        normalize(path) === path &&
        path.length <= 16_384 &&
        hasWellFormedUtf16(path) &&
        !path.includes("\0")
    );
}

function isSafeString(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 16_384 &&
        hasWellFormedUtf16(value) &&
        !value.includes("\0")
    );
}

function isCanonicalTimestamp(value: unknown): value is string {
    if (typeof value !== "string") return false;
    try {
        return new Date(value).toISOString() === value;
    } catch {
        return false;
    }
}

function hasWellFormedUtf16(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
            index++;
            continue;
        }
        if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
}

function isIdentity(value: unknown): value is string {
    return typeof value === "string" && IdentityPattern.test(value);
}

function isOid(value: unknown): value is string {
    return typeof value === "string" && OidPattern.test(value);
}

function validateToken(value: string): void {
    if (!TokenPattern.test(value)) {
        throw new Error("Invalid pending restore operation id");
    }
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
    return required.length === Object.keys(value).length && required.every((key) => Object.hasOwn(value, key));
}

function isSortedUnique(paths: readonly string[]): boolean {
    return paths.every((path, index) => index === 0 || Buffer.from(paths[index - 1]!).compare(Buffer.from(path)) < 0);
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((path, index) => path === right[index]);
}

async function makePrivateDirectory(path: string): Promise<AnchoredJournalDirectoryIdentity> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const state = await lstat(path, { bigint: true });
    if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077n) !== 0n) {
        throw new Error("Pending restore directory is unsafe");
    }
    return {
        dev: state.dev.toString(),
        ino: state.ino.toString(),
        birthtimeNs: state.birthtimeNs.toString(),
    };
}

function sameIdentity(left: AnchoredJournalDirectoryIdentity, right: AnchoredJournalDirectoryIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}
