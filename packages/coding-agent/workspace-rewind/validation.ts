// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
    CapturedPathStateV1,
    WorkspaceCheckpointFailureCode,
    WorkspaceCheckpointV1,
    WorkspaceCoverageReason,
    WorkspacePathChangeV1,
    WorkspaceSnapshotCoverage,
    WorkspaceSnapshotRefV1,
    WorkspaceStateV1,
} from "./types";

const GitOidPattern = /^[0-9a-f]{40}$/;
const Base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const WorkspaceCoverageReasons = new Set<string>([
    "ignored",
    "nested-repository",
    "oversized-untracked",
    "non-utf8-path",
    "hard-linked",
    "special-entry",
    "capture-budget",
]);

const WorkspaceCheckpointFailureCodes = new Set<string>([
    "disabled",
    "git_unavailable",
    "capture_timeout",
    "capture_budget",
    "unstable_file",
    "enospc",
    "quota_exceeded",
    "hosted_pty_running",
    "process_crash_before_finalization",
    "corrupt_snapshot",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
    const allowed = new Set([...required, ...optional]);
    if (Object.keys(value).some((key) => !allowed.has(key))) {
        return false;
    }
    return required.every((key) => Object.hasOwn(value, key));
}

function isGitOid(value: unknown): value is string {
    return typeof value === "string" && GitOidPattern.test(value);
}

function hasUnpairedSurrogate(value: string): boolean {
    for (let index = 0; index < value.length; index++) {
        const codeUnit = value.charCodeAt(index);
        if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const nextCodeUnit = value.charCodeAt(index + 1);
            if (index + 1 >= value.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
                return true;
            }
            index++;
            continue;
        }
        if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
            return true;
        }
    }
    return false;
}

function isCanonicalRelativePath(value: unknown): value is string {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.includes("\\") ||
        value.includes("\0") ||
        hasUnpairedSurrogate(value)
    ) {
        return false;
    }
    if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
        return false;
    }
    const segments = value.split("/");
    return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isNonnegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isWorkspaceCoverageReason(value: unknown): value is WorkspaceCoverageReason {
    return typeof value === "string" && WorkspaceCoverageReasons.has(value);
}

function isWorkspaceCheckpointFailureCode(value: unknown): value is WorkspaceCheckpointFailureCode {
    return typeof value === "string" && WorkspaceCheckpointFailureCodes.has(value);
}

function isStrictBase64(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && Base64Pattern.test(value);
}

function isAsciiLetter(byte: number): boolean {
    return (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
}

function isCanonicalRelativePathBytes(bytes: Uint8Array): boolean {
    if (bytes.length === 0 || bytes[0] === 0x2f) {
        return false;
    }
    if (bytes.length >= 2 && isAsciiLetter(bytes[0]!) && bytes[1] === 0x3a) {
        return false;
    }
    let segmentStart = 0;
    for (let index = 0; index <= bytes.length; index++) {
        if (index < bytes.length && bytes[index] !== 0x2f) {
            if (bytes[index] === 0x00 || bytes[index] === 0x5c) {
                return false;
            }
            continue;
        }
        const segmentLength = index - segmentStart;
        if (
            segmentLength === 0 ||
            (segmentLength === 1 && bytes[segmentStart] === 0x2e) ||
            (segmentLength === 2 && bytes[segmentStart] === 0x2e && bytes[segmentStart + 1] === 0x2e)
        ) {
            return false;
        }
        segmentStart = index + 1;
    }
    return true;
}

function decodeCanonicalRelativePathBytes(value: unknown): Buffer | undefined {
    if (!isStrictBase64(value)) {
        return undefined;
    }
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value || !isCanonicalRelativePathBytes(bytes)) {
        return undefined;
    }
    return bytes;
}

function decodeCapturedPathStateV1(value: unknown): CapturedPathStateV1 | undefined {
    if (!isRecord(value) || typeof value.state !== "string") {
        return undefined;
    }
    if (value.state === "absent") {
        return hasExactKeys(value, ["state"]) ? { state: "absent" } : undefined;
    }
    if (value.state === "file") {
        if (
            !hasExactKeys(value, ["state", "oid", "executable"]) ||
            !isGitOid(value.oid) ||
            typeof value.executable !== "boolean"
        ) {
            return undefined;
        }
        return { state: "file", oid: value.oid, executable: value.executable };
    }
    if (value.state === "symlink") {
        if (!hasExactKeys(value, ["state", "oid"]) || !isGitOid(value.oid)) {
            return undefined;
        }
        return { state: "symlink", oid: value.oid };
    }
    if (value.state === "excluded") {
        if (!hasExactKeys(value, ["state", "reason"]) || !isWorkspaceCoverageReason(value.reason)) {
            return undefined;
        }
        return { state: "excluded", reason: value.reason };
    }
    return undefined;
}

function decodeWorkspaceSnapshotRefV1(value: unknown): WorkspaceSnapshotRefV1 | undefined {
    if (
        !isRecord(value) ||
        !hasExactKeys(value, ["id", "workspaceIdentity", "workspaceIncarnation", "tree", "scopeManifest"]) ||
        !isGitOid(value.id) ||
        typeof value.workspaceIdentity !== "string" ||
        typeof value.workspaceIncarnation !== "string" ||
        !isGitOid(value.tree) ||
        !isGitOid(value.scopeManifest)
    ) {
        return undefined;
    }
    return {
        id: value.id,
        workspaceIdentity: value.workspaceIdentity,
        workspaceIncarnation: value.workspaceIncarnation,
        tree: value.tree,
        scopeManifest: value.scopeManifest,
    };
}

function decodeWorkspacePathChangeV1(value: unknown): WorkspacePathChangeV1 | undefined {
    if (!isRecord(value) || !hasExactKeys(value, ["path", "before", "after"]) || !isCanonicalRelativePath(value.path)) {
        return undefined;
    }
    const before = decodeCapturedPathStateV1(value.before);
    const after = decodeCapturedPathStateV1(value.after);
    if (!before || !after) {
        return undefined;
    }
    return { path: value.path, before, after };
}

function decodeWorkspaceSnapshotCoverage(value: unknown): WorkspaceSnapshotCoverage | undefined {
    if (
        !isRecord(value) ||
        !hasExactKeys(value, ["complete", "eligibleEntryCount", "newlyHashedBytes", "exclusions"]) ||
        typeof value.complete !== "boolean" ||
        !isNonnegativeInteger(value.eligibleEntryCount) ||
        !isNonnegativeInteger(value.newlyHashedBytes) ||
        !Array.isArray(value.exclusions)
    ) {
        return undefined;
    }
    const exclusions: WorkspaceSnapshotCoverage["exclusions"] = [];
    const seenLocatorBytes = new Set<string>();
    for (const item of value.exclusions) {
        if (!isRecord(item) || !hasExactKeys(item, ["reason"], ["path", "pathBytesBase64"])) {
            return undefined;
        }
        const hasPath = Object.hasOwn(item, "path");
        const hasPathBytes = Object.hasOwn(item, "pathBytesBase64");
        if (hasPath === hasPathBytes || !isWorkspaceCoverageReason(item.reason)) {
            return undefined;
        }
        if (hasPath) {
            if (!isCanonicalRelativePath(item.path)) {
                return undefined;
            }
            const locatorBytes = Buffer.from(item.path, "utf8").toString("hex");
            if (seenLocatorBytes.has(locatorBytes)) {
                return undefined;
            }
            seenLocatorBytes.add(locatorBytes);
            exclusions.push({ path: item.path, reason: item.reason });
            continue;
        }
        const pathBytesBase64 = item.pathBytesBase64;
        const pathBytes = decodeCanonicalRelativePathBytes(pathBytesBase64);
        if (!pathBytes || typeof pathBytesBase64 !== "string") {
            return undefined;
        }
        const locatorBytes = pathBytes.toString("hex");
        if (seenLocatorBytes.has(locatorBytes)) {
            return undefined;
        }
        seenLocatorBytes.add(locatorBytes);
        exclusions.push({ pathBytesBase64, reason: item.reason });
    }
    return {
        complete: value.complete,
        eligibleEntryCount: value.eligibleEntryCount,
        newlyHashedBytes: value.newlyHashedBytes,
        exclusions,
    };
}

function decodePathStates(value: unknown): Array<{ path: string; state: CapturedPathStateV1 }> | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const decoded: Array<{ path: string; state: CapturedPathStateV1 }> = [];
    const seenPaths = new Set<string>();
    for (const item of value) {
        if (!isRecord(item) || !hasExactKeys(item, ["path", "state"]) || !isCanonicalRelativePath(item.path)) {
            return undefined;
        }
        if (seenPaths.has(item.path)) {
            return undefined;
        }
        const state = decodeCapturedPathStateV1(item.state);
        if (!state) {
            return undefined;
        }
        seenPaths.add(item.path);
        decoded.push({ path: item.path, state });
    }
    return decoded;
}

function decodeUniquePaths(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const paths: string[] = [];
    const seenPaths = new Set<string>();
    for (const path of value) {
        if (!isCanonicalRelativePath(path) || seenPaths.has(path)) {
            return undefined;
        }
        seenPaths.add(path);
        paths.push(path);
    }
    return paths;
}

export function decodeWorkspaceCheckpointV1(value: unknown): WorkspaceCheckpointV1 | undefined {
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.status !== "string") {
        return undefined;
    }
    if (value.status === "available") {
        if (
            !hasExactKeys(value, [
                "schemaVersion",
                "status",
                "originSessionId",
                "turnId",
                "workspaceIdentity",
                "workspaceIncarnation",
                "before",
                "after",
                "changes",
                "coverage",
            ]) ||
            typeof value.originSessionId !== "string" ||
            typeof value.turnId !== "string" ||
            typeof value.workspaceIdentity !== "string" ||
            typeof value.workspaceIncarnation !== "string" ||
            !Array.isArray(value.changes)
        ) {
            return undefined;
        }
        const before = decodeWorkspaceSnapshotRefV1(value.before);
        const after = decodeWorkspaceSnapshotRefV1(value.after);
        const coverage = decodeWorkspaceSnapshotCoverage(value.coverage);
        if (!before || !after || !coverage) {
            return undefined;
        }
        const changes: WorkspacePathChangeV1[] = [];
        const seenPaths = new Set<string>();
        for (const item of value.changes) {
            const change = decodeWorkspacePathChangeV1(item);
            if (!change || seenPaths.has(change.path)) {
                return undefined;
            }
            seenPaths.add(change.path);
            changes.push(change);
        }
        return {
            schemaVersion: 1,
            status: "available",
            originSessionId: value.originSessionId,
            turnId: value.turnId,
            workspaceIdentity: value.workspaceIdentity,
            workspaceIncarnation: value.workspaceIncarnation,
            before,
            after,
            changes,
            coverage,
        };
    }
    if (value.status !== "unavailable") {
        return undefined;
    }
    if (
        !hasExactKeys(
            value,
            ["schemaVersion", "status", "originSessionId", "turnId", "workspaceIdentity", "reasonCode", "message"],
            ["workspaceIncarnation", "coverage"]
        ) ||
        typeof value.originSessionId !== "string" ||
        typeof value.turnId !== "string" ||
        typeof value.workspaceIdentity !== "string" ||
        !isWorkspaceCheckpointFailureCode(value.reasonCode) ||
        typeof value.message !== "string"
    ) {
        return undefined;
    }
    let workspaceIncarnation: string | undefined;
    if (Object.hasOwn(value, "workspaceIncarnation")) {
        if (typeof value.workspaceIncarnation !== "string") {
            return undefined;
        }
        workspaceIncarnation = value.workspaceIncarnation;
    }
    let coverage: WorkspaceSnapshotCoverage | undefined;
    if (Object.hasOwn(value, "coverage")) {
        coverage = decodeWorkspaceSnapshotCoverage(value.coverage);
        if (!coverage) {
            return undefined;
        }
    }
    return {
        schemaVersion: 1,
        status: "unavailable",
        originSessionId: value.originSessionId,
        turnId: value.turnId,
        workspaceIdentity: value.workspaceIdentity,
        ...(workspaceIncarnation == null ? {} : { workspaceIncarnation }),
        reasonCode: value.reasonCode,
        message: value.message,
        ...(coverage == null ? {} : { coverage }),
    };
}

export function decodeWorkspaceStateV1(value: unknown): WorkspaceStateV1 | undefined {
    if (
        !isRecord(value) ||
        !hasExactKeys(
            value,
            [
                "schemaVersion",
                "sessionId",
                "operationId",
                "workspaceIdentity",
                "workspaceIncarnation",
                "kind",
                "applyMode",
                "forcedPaths",
                "currentSnapshot",
                "currentStates",
            ],
            ["rewind"]
        ) ||
        value.schemaVersion !== 1 ||
        typeof value.sessionId !== "string" ||
        typeof value.operationId !== "string" ||
        typeof value.workspaceIdentity !== "string" ||
        typeof value.workspaceIncarnation !== "string" ||
        (value.kind !== "rewind" && value.kind !== "redo") ||
        (value.applyMode !== "normal" && value.applyMode !== "force-drift")
    ) {
        return undefined;
    }
    const forcedPaths = decodeUniquePaths(value.forcedPaths);
    const currentSnapshot = decodeWorkspaceSnapshotRefV1(value.currentSnapshot);
    const currentStates = decodePathStates(value.currentStates);
    if (!forcedPaths || !currentSnapshot || !currentStates) {
        return undefined;
    }
    let rewind: WorkspaceStateV1["rewind"];
    if (Object.hasOwn(value, "rewind")) {
        const rewindValue = value.rewind;
        if (
            !isRecord(rewindValue) ||
            !hasExactKeys(rewindValue, [
                "fromLeafId",
                "targetTurnId",
                "targetBoundaryId",
                "redoSnapshot",
                "redoStates",
            ]) ||
            (rewindValue.fromLeafId !== null && typeof rewindValue.fromLeafId !== "string") ||
            typeof rewindValue.targetTurnId !== "string" ||
            (rewindValue.targetBoundaryId !== null && typeof rewindValue.targetBoundaryId !== "string")
        ) {
            return undefined;
        }
        const fromLeafId = typeof rewindValue.fromLeafId === "string" ? rewindValue.fromLeafId : null;
        const targetBoundaryId = typeof rewindValue.targetBoundaryId === "string" ? rewindValue.targetBoundaryId : null;
        const redoSnapshot = decodeWorkspaceSnapshotRefV1(rewindValue.redoSnapshot);
        const redoStates = decodePathStates(rewindValue.redoStates);
        if (!redoSnapshot || !redoStates) {
            return undefined;
        }
        rewind = {
            fromLeafId,
            targetTurnId: rewindValue.targetTurnId,
            targetBoundaryId,
            redoSnapshot,
            redoStates,
        };
    }
    return {
        schemaVersion: 1,
        sessionId: value.sessionId,
        operationId: value.operationId,
        workspaceIdentity: value.workspaceIdentity,
        workspaceIncarnation: value.workspaceIncarnation,
        kind: value.kind,
        applyMode: value.applyMode,
        forcedPaths,
        currentSnapshot,
        currentStates,
        ...(rewind == null ? {} : { rewind }),
    };
}
