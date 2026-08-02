// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmod, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SessionTreeEntry } from "@crest/agent/harness/types";

import { encodeDurableJson, removeDurableFile, writeDurableJson } from "./durability";
import { readProcessStartToken, type ProcessOwnerIdentity } from "./process-owner";
import type { WorkspaceSnapshotStore } from "./snapshot-store";
import type { WorkspaceSnapshotRefV1 } from "./types";
import { decodeWorkspaceSnapshotRefV1 } from "./validation";

const TokenPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface UnboundPendingBoundaryV1 {
    boundaryToken: string;
    sessionId: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    processOwner: ProcessOwnerIdentity;
    nonce: string;
    before: WorkspaceSnapshotRefV1;
}

export interface PendingWorkspaceBoundaryV1 extends UnboundPendingBoundaryV1 {
    userEntryId?: string;
    after?: WorkspaceSnapshotRefV1;
}

export interface RecoveredPendingBoundary {
    record: PendingWorkspaceBoundaryV1;
    disposition: "resume-finalization" | "retire-unbound" | "owner-still-live";
}

export type ProcessOwnerStatus = "live" | "dead" | "unknown";

export interface ProcessOwnerProbe {
    signal(pid: number): void;
    readStartToken(pid: number): Promise<string>;
}

export class PendingBoundaryStore {
    readonly store: WorkspaceSnapshotStore;
    readonly pendingRoot: string;
    readonly processOwnerProbe: ProcessOwnerProbe;

    constructor(
        store: WorkspaceSnapshotStore,
        processOwnerProbe: ProcessOwnerProbe = {
            signal: (pid) => process.kill(pid, 0),
            readStartToken: readProcessStartToken,
        }
    ) {
        this.store = store;
        this.pendingRoot = join(store.storeRoot, "journal", "pending");
        this.processOwnerProbe = processOwnerProbe;
    }

    async begin(record: UnboundPendingBoundaryV1): Promise<void> {
        validatePendingRecord(record);
        this.assertIdentity(record);
        await makePrivateDirectory(this.pendingRoot);
        await assertPendingMissing(this.path(record.boundaryToken));
        await this.store.anchorPending(record);
        try {
            await writeDurableJson(this.path(record.boundaryToken), record);
        } catch (error) {
            await this.store.deleteCrestRef(this.store.pendingRefName(record));
            throw error;
        }
    }

    async bind(boundaryToken: string, userEntryId: string): Promise<void> {
        const record = await this.read(boundaryToken);
        if (record.userEntryId != null || record.after != null || !isSafeString(userEntryId)) {
            throw new Error("Invalid pending boundary bind transition");
        }
        await this.persist({ ...record, userEntryId });
    }

    async recordAfter(boundaryToken: string, after: WorkspaceSnapshotRefV1): Promise<void> {
        const record = await this.read(boundaryToken);
        if (!record.userEntryId) {
            throw new Error("Pending boundary must be bound before recording after snapshot");
        }
        if (record.after != null) {
            throw new Error("Invalid pending boundary after transition");
        }
        await this.persist({ ...record, after });
    }

    async complete(boundaryToken: string): Promise<void> {
        const record = await this.read(boundaryToken);
        if (!record.userEntryId || !record.after) {
            throw new Error("Pending boundary cannot complete before finalization");
        }
        await this.remove(record);
    }

    async retireUnavailable(boundaryToken: string): Promise<void> {
        const record = await this.read(boundaryToken);
        if (!record.userEntryId) {
            throw new Error("Only a bound pending boundary can retire unavailable");
        }
        await this.remove(record);
    }

    async retireUnbound(boundaryToken: string, processOwner: ProcessOwnerIdentity): Promise<void> {
        const record = await this.read(boundaryToken);
        if (record.userEntryId || record.after) {
            throw new Error("Only an unbound pending boundary can retire unbound");
        }
        if (!sameProcessOwner(record.processOwner, processOwner)) {
            throw new Error("Pending boundary belongs to another process owner");
        }
        await this.remove(record);
    }

    async retireRecoveredUnbound(boundaryToken: string): Promise<void> {
        const record = await this.read(boundaryToken);
        if (record.userEntryId || record.after) {
            throw new Error("Only an unbound pending boundary can retire after recovery");
        }
        const ownerStatus = await probeProcessOwner(record.processOwner, this.processOwnerProbe);
        if (ownerStatus !== "dead") {
            throw new Error("Pending boundary process owner is not proven dead");
        }
        await this.remove(record);
    }

    async remove(record: PendingWorkspaceBoundaryV1): Promise<void> {
        await this.store.deleteCrestRef(this.store.pendingRefName(record));
        await removeDurableFile(this.path(record.boundaryToken));
    }

    async recover(_sessionEntries: SessionTreeEntry[]): Promise<RecoveredPendingBoundary[]> {
        const records = await scanPendingBoundaryRecords(this.store);
        const recovered: RecoveredPendingBoundary[] = [];
        for (const record of records) {
            const ownerStatus = await probeProcessOwner(record.processOwner, this.processOwnerProbe);
            let disposition: RecoveredPendingBoundary["disposition"];
            if (ownerStatus !== "dead") {
                disposition = "owner-still-live";
            } else if (!record.userEntryId) {
                disposition = "retire-unbound";
            } else {
                disposition = "resume-finalization";
            }
            recovered.push({ record, disposition });
        }
        return recovered;
    }

    async persist(record: PendingWorkspaceBoundaryV1): Promise<void> {
        validatePendingRecord(record);
        this.assertIdentity(record);
        await this.store.anchorPending(record);
        await writeDurableJson(this.path(record.boundaryToken), record);
    }

    async read(boundaryToken: string): Promise<PendingWorkspaceBoundaryV1> {
        validateToken(boundaryToken, "boundary token");
        const path = this.path(boundaryToken);
        await assertPrivateRecord(path);
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        const record = decodePendingWorkspaceBoundaryV1(value);
        if (!record) {
            throw new Error("Invalid pending boundary record");
        }
        return resolvePendingRefRecord(this.store, record);
    }

    path(boundaryToken: string): string {
        validateToken(boundaryToken, "boundary token");
        return join(this.pendingRoot, `${boundaryToken}.json`);
    }

    assertIdentity(record: PendingWorkspaceBoundaryV1): void {
        if (
            record.workspaceIdentity !== this.store.identity.workspaceIdentity ||
            record.workspaceIncarnation !== this.store.identity.workspaceIncarnation
        ) {
            throw new Error("Pending boundary belongs to another workspace incarnation");
        }
    }
}

function sameProcessOwner(left: ProcessOwnerIdentity, right: ProcessOwnerIdentity): boolean {
    return left.pid === right.pid && left.processStartToken === right.processStartToken && left.nonce === right.nonce;
}

export async function scanPendingBoundaryRecords(store: WorkspaceSnapshotStore): Promise<PendingWorkspaceBoundaryV1[]> {
    const root = join(store.storeRoot, "journal", "pending");
    const names = await readOwnerDirectory(root);
    const records: PendingWorkspaceBoundaryV1[] = [];
    for (const name of names.sort()) {
        if (!name.endsWith(".json") || !TokenPattern.test(name.slice(0, -5))) {
            throw new Error("Invalid pending boundary filename");
        }
        const path = join(root, name);
        await assertPrivateRecord(path);
        const bytes = await readFile(path, "utf8");
        const record = decodePendingWorkspaceBoundaryV1(JSON.parse(bytes));
        if (!record || `${record.boundaryToken}.json` !== name) {
            throw new Error("Invalid pending boundary record");
        }
        records.push(await resolvePendingRefRecord(store, record));
    }
    return records;
}

export function decodePendingWorkspaceBoundaryV1(value: unknown): PendingWorkspaceBoundaryV1 | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const allowed = new Set([
        "boundaryToken",
        "sessionId",
        "workspaceIdentity",
        "workspaceIncarnation",
        "processOwner",
        "nonce",
        "before",
        "userEntryId",
        "after",
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key))) {
        return undefined;
    }
    if (
        !TokenPattern.test(String(value.boundaryToken ?? "")) ||
        !isSafeString(value.sessionId) ||
        !isIdentity(value.workspaceIdentity) ||
        !isIdentity(value.workspaceIncarnation) ||
        !isProcessOwner(value.processOwner) ||
        !isNonce(value.nonce)
    ) {
        return undefined;
    }
    const before = decodeWorkspaceSnapshotRefV1(value.before);
    if (
        !before ||
        before.workspaceIdentity !== value.workspaceIdentity ||
        before.workspaceIncarnation !== value.workspaceIncarnation
    ) {
        return undefined;
    }
    if (value.userEntryId != null && !isSafeString(value.userEntryId)) {
        return undefined;
    }
    const after = value.after == null ? undefined : decodeWorkspaceSnapshotRefV1(value.after);
    if (
        value.after != null &&
        (!after ||
            value.userEntryId == null ||
            after.workspaceIdentity !== value.workspaceIdentity ||
            after.workspaceIncarnation !== value.workspaceIncarnation)
    ) {
        return undefined;
    }
    return {
        boundaryToken: value.boundaryToken as string,
        sessionId: value.sessionId as string,
        workspaceIdentity: value.workspaceIdentity as string,
        workspaceIncarnation: value.workspaceIncarnation as string,
        processOwner: value.processOwner,
        nonce: value.nonce as string,
        before,
        ...(value.userEntryId == null ? {} : { userEntryId: value.userEntryId as string }),
        ...(after == null ? {} : { after }),
    };
}

async function resolvePendingRefRecord(
    store: WorkspaceSnapshotStore,
    jsonRecord: PendingWorkspaceBoundaryV1
): Promise<PendingWorkspaceBoundaryV1> {
    const descriptor = await store.readCrestRefBlob(store.pendingRefName(jsonRecord));
    if (!descriptor) {
        return jsonRecord;
    }
    let value: unknown;
    try {
        value = JSON.parse(descriptor.bytes.toString("utf8"));
    } catch {
        throw new Error("Invalid pending boundary ref descriptor");
    }
    const refRecord = decodePendingWorkspaceBoundaryV1(value);
    if (
        !refRecord ||
        !encodeDurableJson(refRecord).equals(descriptor.bytes) ||
        store.pendingRefName(refRecord) !== store.pendingRefName(jsonRecord) ||
        !isPendingSuccessor(jsonRecord, refRecord)
    ) {
        throw new Error("Invalid pending boundary ref descriptor");
    }
    return refRecord;
}

function isPendingSuccessor(previous: PendingWorkspaceBoundaryV1, next: PendingWorkspaceBoundaryV1): boolean {
    const previousBase = {
        boundaryToken: previous.boundaryToken,
        sessionId: previous.sessionId,
        workspaceIdentity: previous.workspaceIdentity,
        workspaceIncarnation: previous.workspaceIncarnation,
        processOwner: previous.processOwner,
        nonce: previous.nonce,
        before: previous.before,
    };
    const nextBase = {
        boundaryToken: next.boundaryToken,
        sessionId: next.sessionId,
        workspaceIdentity: next.workspaceIdentity,
        workspaceIncarnation: next.workspaceIncarnation,
        processOwner: next.processOwner,
        nonce: next.nonce,
        before: next.before,
    };
    if (!encodeDurableJson(previousBase).equals(encodeDurableJson(nextBase))) {
        return false;
    }
    if (previous.userEntryId != null && previous.userEntryId !== next.userEntryId) {
        return false;
    }
    if (previous.after != null && !encodeDurableJson(previous.after).equals(encodeDurableJson(next.after))) {
        return false;
    }
    return true;
}

function validatePendingRecord(record: PendingWorkspaceBoundaryV1): void {
    if (!decodePendingWorkspaceBoundaryV1(record)) {
        throw new Error("Invalid pending boundary record");
    }
}

export async function probeProcessOwner(
    owner: ProcessOwnerIdentity,
    probe: ProcessOwnerProbe = {
        signal: (pid) => process.kill(pid, 0),
        readStartToken: readProcessStartToken,
    }
): Promise<ProcessOwnerStatus> {
    try {
        probe.signal(owner.pid);
    } catch (error) {
        if (isNodeError(error) && error.code === "ESRCH") {
            return "dead";
        }
        return "unknown";
    }
    try {
        return (await probe.readStartToken(owner.pid)) === owner.processStartToken ? "live" : "dead";
    } catch {
        return "unknown";
    }
}

function isProcessOwner(value: unknown): value is ProcessOwnerIdentity {
    return (
        isRecord(value) &&
        Object.keys(value).sort().join(",") === "nonce,pid,processStartToken" &&
        Number.isSafeInteger(value.pid) &&
        Number(value.pid) > 0 &&
        isSafeString(value.processStartToken) &&
        isNonce(value.nonce)
    );
}

function isIdentity(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isNonce(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{32,128}$/.test(value);
}

function isSafeString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 1024 && !value.includes("\0");
}

function validateToken(value: string, label: string): void {
    if (!TokenPattern.test(value)) {
        throw new Error(`Invalid ${label}`);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

async function makePrivateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error("Workspace owner directory is unsafe");
    }
    await chmod(path, 0o700);
}

async function assertPrivateRecord(path: string): Promise<void> {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0) {
        throw new Error("Workspace owner record is unsafe");
    }
}

async function assertPendingMissing(path: string): Promise<void> {
    try {
        await lstat(path);
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return;
        }
        throw error;
    }
    throw new Error("Pending boundary already exists");
}

async function readOwnerDirectory(path: string): Promise<string[]> {
    let metadata;
    try {
        metadata = await lstat(path);
    } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
        throw new Error("Workspace owner directory is unsafe");
    }
    return readdir(path);
}
