// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { encodeDurableJson } from "./durability";
import {
    readAnchoredJournalEntry,
    removeAnchoredJournalEntry,
    renameAnchoredJournalEntry,
    writeAnchoredJournalEntry,
    type AnchoredJournalDirectoryIdentity,
    type AnchoredJournalEntry,
} from "./journal-directory";
import type { RestoreTargetV1 } from "./restore-plan";
import { WorkspaceSnapshotStore } from "./snapshot-store";
import type { CapturedPathStateV1, WorkspaceCoverageReason, WorkspaceSnapshotRefV1 } from "./types";
import { decodeWorkspaceSnapshotRefV1 } from "./validation";

export interface PendingWorkspaceRestorePathV1 {
    path: string;
    before: CapturedPathStateV1;
    target: CapturedPathStateV1;
    createdParentDirectories: string[];
}

export interface PendingWorkspaceRestoreV1 {
    schemaVersion: 1;
    operationId: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    sessionId: string;
    sessionPath: string;
    target: RestoreTargetV1;
    commitParentId: string | null;
    applyMode: "normal" | "force-drift";
    forcedPaths: string[];
    expectedSemanticLeafId: string | null;
    workspaceStateEntryId: string;
    safetySnapshot: WorkspaceSnapshotRefV1;
    paths: PendingWorkspaceRestorePathV1[];
}

export type ScannedPendingWorkspaceRestore =
    | { kind: "none" }
    | { kind: "valid"; record: PendingWorkspaceRestoreV1 }
    | { kind: "corrupt"; operationId: string; message: string; bytes: Buffer };

const TokenPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IdentityPattern = /^[0-9a-f]{64}$/;
const MaximumPendingBytes = 64 * 1024 * 1024;
const MaximumRestorePaths = 4_096;
const CoverageReasons = new Set<WorkspaceCoverageReason>([
    "ignored",
    "nested-repository",
    "oversized-untracked",
    "non-utf8-path",
    "hard-linked",
    "special-entry",
    "capture-budget",
]);

export class PendingWorkspaceRestoreStore {
    readonly store: WorkspaceSnapshotStore;
    readonly root: string;
    rootIdentity?: AnchoredJournalDirectoryIdentity;

    constructor(store: WorkspaceSnapshotStore) {
        if (!isAbsolute(store.storeRoot)) {
            throw new Error("Pending restore store root must be absolute");
        }
        this.store = store;
        this.root = join(store.storeRoot, "journal", "restore");
    }

    readCandidate(): Promise<ScannedPendingWorkspaceRestore> {
        return this.scanActive();
    }

    readLocked(): Promise<ScannedPendingWorkspaceRestore> {
        return this.scanActive();
    }

    async publishLocked(record: PendingWorkspaceRestoreV1): Promise<void> {
        const decoded = decodePendingWorkspaceRestoreV1(record);
        if (!decoded) {
            throw new Error("Invalid pending workspace restore");
        }
        this.assertIdentity(decoded);
        await this.store.verify(decoded.safetySnapshot);
        await this.store.anchorSnapshot(decoded.safetySnapshot);
        await makePrivateDirectory(this.root);
        const active = await this.readActiveEntry();
        if (!active) {
            throw new Error("Pending restore directory disappeared before publication");
        }
        if (active.source) {
            throw new Error("A workspace restore is already pending");
        }
        await writeAnchoredJournalEntry({
            root: this.root,
            rootIdentity: active.identity,
            destinationName: "pending.json",
            bytes: encodeDurableJson(decoded),
        });
    }

    async updateCreatedParentDirectoriesLocked(
        operationId: string,
        path: string,
        directories: readonly string[]
    ): Promise<PendingWorkspaceRestoreV1> {
        validateToken(operationId);
        const { rootIdentity, source, record } = await this.requireValidActive();
        if (record.operationId !== operationId) {
            throw new Error("Pending restore belongs to another operation");
        }
        const index = record.paths.findIndex((item) => item.path === path);
        if (index < 0) {
            throw new Error("Pending restore path does not belong to the operation");
        }
        if (!isValidCreatedDirectories(directories, path)) {
            throw new Error("Invalid pending restore created parent directories");
        }
        const paths = record.paths.map((item, itemIndex) =>
            itemIndex === index ? { ...item, createdParentDirectories: [...directories] } : item
        );
        const next = decodePendingWorkspaceRestoreV1({ ...record, paths });
        if (!next) {
            throw new Error("Invalid pending restore path progress");
        }
        await writeAnchoredJournalEntry({
            root: this.root,
            rootIdentity,
            destinationName: source.name,
            bytes: encodeDurableJson(next),
            expectedDestination: source,
        });
        return next;
    }

    async removeLocked(operationId: string): Promise<void> {
        validateToken(operationId);
        const { rootIdentity, source, record } = await this.requireValidActive();
        if (record.operationId !== operationId) {
            throw new Error("Pending restore belongs to another operation");
        }
        await removeAnchoredJournalEntry({
            root: this.root,
            rootIdentity,
            source,
        });
    }

    async resolveToAuditLocked(operationId: string, disposition: "keep-current" | "quarantine"): Promise<void> {
        validateToken(operationId);
        const active = await this.readActiveEntry();
        if (!active?.source) {
            throw new Error("No workspace restore is pending");
        }
        const source = active.source;
        const candidate = decodeCandidate(source.bytes, this.store);
        const candidateOperationId = candidate.kind === "valid" ? candidate.record.operationId : candidate.operationId;
        if (candidateOperationId !== operationId) {
            throw new Error("Pending restore belongs to another operation");
        }
        if (
            (disposition === "keep-current" && candidate.kind !== "valid") ||
            (disposition === "quarantine" && candidate.kind !== "corrupt")
        ) {
            throw new Error("Pending restore audit disposition does not match the active record");
        }
        const destinationName = `resolved-${operationId}-${Date.now()}-${disposition}.json`;
        await renameAnchoredJournalEntry({
            root: this.root,
            rootIdentity: active.identity,
            source,
            destinationName,
        });
    }

    async scanActive(): Promise<ScannedPendingWorkspaceRestore> {
        const source = (await this.readActiveEntry())?.source;
        if (!source) {
            return { kind: "none" };
        }
        return decodeCandidate(source.bytes, this.store);
    }

    async requireValidActive(): Promise<{
        rootIdentity: AnchoredJournalDirectoryIdentity;
        source: AnchoredJournalEntry;
        record: PendingWorkspaceRestoreV1;
    }> {
        const active = await this.readActiveEntry();
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

    async readActiveEntry(): Promise<
        { identity: AnchoredJournalDirectoryIdentity; source?: AnchoredJournalEntry } | undefined
    > {
        const active = await readAnchoredJournalEntry({
            root: this.root,
            name: "pending.json",
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

    assertIdentity(record: PendingWorkspaceRestoreV1): void {
        if (
            record.workspaceIdentity !== this.store.identity.workspaceIdentity ||
            record.workspaceIncarnation !== this.store.identity.workspaceIncarnation
        ) {
            throw new Error("Pending restore belongs to another workspace incarnation");
        }
    }
}

export function decodePendingWorkspaceRestoreV1(value: unknown): PendingWorkspaceRestoreV1 | undefined {
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
            "commitParentId",
            "applyMode",
            "forcedPaths",
            "expectedSemanticLeafId",
            "workspaceStateEntryId",
            "safetySnapshot",
            "paths",
        ]) ||
        value.schemaVersion !== 1 ||
        !TokenPattern.test(String(value.operationId ?? "")) ||
        !isIdentity(value.workspaceIdentity) ||
        !isIdentity(value.workspaceIncarnation) ||
        !isSafeString(value.sessionId) ||
        !isAbsoluteSafePath(value.sessionPath) ||
        (value.commitParentId != null && !isSafeString(value.commitParentId)) ||
        (value.applyMode !== "normal" && value.applyMode !== "force-drift") ||
        !Array.isArray(value.forcedPaths) ||
        (value.expectedSemanticLeafId != null && !isSafeString(value.expectedSemanticLeafId)) ||
        !isSafeString(value.workspaceStateEntryId) ||
        !Array.isArray(value.paths) ||
        value.paths.length > MaximumRestorePaths
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
    const safetySnapshot = decodeWorkspaceSnapshotRefV1(value.safetySnapshot);
    if (
        !safetySnapshot ||
        safetySnapshot.workspaceIdentity !== value.workspaceIdentity ||
        safetySnapshot.workspaceIncarnation !== value.workspaceIncarnation
    ) {
        return undefined;
    }
    const paths: PendingWorkspaceRestorePathV1[] = [];
    for (const item of value.paths) {
        const decoded = decodePendingPath(item);
        if (!decoded) {
            return undefined;
        }
        paths.push(decoded);
    }
    if (!isSortedUnique(paths.map((item) => item.path))) {
        return undefined;
    }
    const forcedPaths = value.forcedPaths as unknown[];
    if (
        !forcedPaths.every(isCanonicalRelativePath) ||
        !isSortedUnique(forcedPaths as string[]) ||
        forcedPaths.some((path) => !paths.some((item) => item.path === path)) ||
        (value.applyMode === "normal" && forcedPaths.length > 0)
    ) {
        return undefined;
    }
    return {
        schemaVersion: 1,
        operationId: value.operationId as string,
        workspaceIdentity: value.workspaceIdentity as string,
        workspaceIncarnation: value.workspaceIncarnation as string,
        sessionId: value.sessionId as string,
        sessionPath: value.sessionPath as string,
        target,
        commitParentId: value.commitParentId as string | null,
        applyMode: value.applyMode,
        forcedPaths: forcedPaths as string[],
        expectedSemanticLeafId: value.expectedSemanticLeafId as string | null,
        workspaceStateEntryId: value.workspaceStateEntryId as string,
        safetySnapshot,
        paths,
    };
}

function decodePendingPath(value: unknown): PendingWorkspaceRestorePathV1 | undefined {
    if (
        !isRecord(value) ||
        !hasExactKeys(value, ["path", "before", "target", "createdParentDirectories"]) ||
        !isCanonicalRelativePath(value.path) ||
        !Array.isArray(value.createdParentDirectories)
    ) {
        return undefined;
    }
    const before = decodeCapturedState(value.before);
    const target = decodeCapturedState(value.target);
    if (!before || !target || before.state === "excluded" || target.state === "excluded") {
        return undefined;
    }
    if (!isValidCreatedDirectories(value.createdParentDirectories, value.path)) {
        return undefined;
    }
    return {
        path: value.path,
        before,
        target,
        createdParentDirectories: [...value.createdParentDirectories],
    };
}

function decodeCapturedState(value: unknown): CapturedPathStateV1 | undefined {
    if (!isRecord(value) || typeof value.state !== "string") {
        return undefined;
    }
    if (value.state === "absent") {
        return hasExactKeys(value, ["state"]) ? { state: "absent" } : undefined;
    }
    if (value.state === "file") {
        return hasExactKeys(value, ["state", "oid", "executable"]) &&
            isOid(value.oid) &&
            typeof value.executable === "boolean"
            ? { state: "file", oid: value.oid, executable: value.executable }
            : undefined;
    }
    if (value.state === "symlink") {
        return hasExactKeys(value, ["state", "oid"]) && isOid(value.oid)
            ? { state: "symlink", oid: value.oid }
            : undefined;
    }
    if (value.state === "excluded") {
        return hasExactKeys(value, ["state", "reason"]) && CoverageReasons.has(value.reason as WorkspaceCoverageReason)
            ? { state: "excluded", reason: value.reason as WorkspaceCoverageReason }
            : undefined;
    }
    return undefined;
}

function decodeRestoreTargetV1(value: unknown): RestoreTargetV1 | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (value.kind === "rewind" && hasExactKeys(value, ["kind", "targetTurnId"]) && isSafeString(value.targetTurnId)) {
        return { kind: "rewind", targetTurnId: value.targetTurnId };
    }
    if (value.kind === "redo" && hasExactKeys(value, ["kind"])) {
        return { kind: "redo" };
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
        hasExactKeys(value, ["kind", "sourceTurnId", "undoOperationId"]) &&
        isSafeString(value.sourceTurnId) &&
        isSafeString(value.undoOperationId)
    ) {
        return {
            kind: "turn-redo",
            sourceTurnId: value.sourceTurnId,
            undoOperationId: value.undoOperationId,
        };
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
    const record = decodePendingWorkspaceRestoreV1(value);
    if (!record || !bytes.equals(encodeDurableJson(record))) {
        return corruptCandidate(bytes, "Pending workspace restore is not canonical or has an invalid schema");
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
    const text = bytes.toString("utf8");
    const matched = /"operationId"\s*:\s*"([^"\\]*)"/.exec(text)?.[1];
    const operationId =
        matched && TokenPattern.test(matched) ? matched : `corrupt-${createHash("sha1").update(bytes).digest("hex")}`;
    return { kind: "corrupt", operationId, message, bytes };
}

function isValidCreatedDirectories(value: readonly unknown[], path: string): value is readonly string[] {
    return (
        value.every(isCanonicalRelativePath) &&
        isSortedUnique(value as string[]) &&
        value.every((directory) => path.startsWith(`${directory}/`))
    );
}

function isCanonicalRelativePath(path: unknown): path is string {
    return (
        typeof path === "string" &&
        path.length > 0 &&
        path.length <= 4_096 &&
        !path.includes("\0") &&
        !path.includes("\\") &&
        !path.startsWith("/") &&
        !/^[A-Za-z]:/.test(path) &&
        path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    );
}

function isAbsoluteSafePath(path: unknown): path is string {
    return typeof path === "string" && isAbsolute(path) && path.length <= 16_384 && !path.includes("\0");
}

function isSafeString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !value.includes("\0");
}

function isIdentity(value: unknown): value is string {
    return typeof value === "string" && IdentityPattern.test(value);
}

function isOid(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
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
    return paths.every((path, index) => index === 0 || comparePathBytes(paths[index - 1]!, path) < 0);
}

function comparePathBytes(left: string, right: string): number {
    return Buffer.from(left).compare(Buffer.from(right));
}

async function makePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const state = await lstat(path, { bigint: true });
    if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o077n) !== 0n) {
        throw new Error("Pending restore directory is unsafe");
    }
}

function sameIdentity(left: AnchoredJournalDirectoryIdentity, right: AnchoredJournalDirectoryIdentity): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}
