// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

import { encodeDurableJson, writeDurableJson } from "./durability";
import { validateWorkspaceRelativePath } from "./stored-manifest";
import type {
    WorkspaceCoverageReason,
    WorkspaceSnapshotCoverage,
    WorkspaceSnapshotCoverageExclusion,
    WorkspaceSnapshotRefV1,
} from "./types";

const OidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const IdentityPattern = /^[0-9a-f]{64}$/;
const CursorHashPattern = /^[0-9a-f]{64}$/;
const CoverageReasons = new Set<WorkspaceCoverageReason>([
    "ignored",
    "nested-repository",
    "oversized-untracked",
    "non-utf8-path",
    "hard-linked",
    "special-entry",
    "capture-budget",
]);

export interface StoredWorkspaceTrackerStateV1 {
    schemaversion: 1;
    workspaceidentity: string;
    workspaceincarnation: string;
    current: WorkspaceSnapshotRefV1;
    coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
    cursorhash: string;
}

export interface WorkspaceTrackerStateSnapshotVerifier {
    verifyOwnedSnapshot(snapshot: WorkspaceSnapshotRefV1): Promise<void>;
}

export type LoadedWorkspaceTrackerState =
    | {
          status: "trusted";
          current: WorkspaceSnapshotRefV1;
          coverage: Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
      }
    | { status: "untrusted" };

export async function loadWorkspaceTrackerState(input: {
    storeRoot: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    verifier: WorkspaceTrackerStateSnapshotVerifier;
}): Promise<LoadedWorkspaceTrackerState> {
    try {
        validateLocation(input.storeRoot, input.workspaceIdentity, input.workspaceIncarnation);
        const stateBytes = await readPrivateRegularFile(statePath(input.storeRoot));
        const value: unknown = JSON.parse(stateBytes.toString("utf8"));
        if (!encodeDurableJson(value).equals(stateBytes)) return { status: "untrusted" };
        const state = decodeState(value);
        if (
            state.workspaceidentity !== input.workspaceIdentity ||
            state.workspaceincarnation !== input.workspaceIncarnation ||
            state.current.workspaceIdentity !== input.workspaceIdentity ||
            state.current.workspaceIncarnation !== input.workspaceIncarnation
        ) {
            return { status: "untrusted" };
        }
        const cursor = await readPrivateRegularFile(committedCursorPath(input.storeRoot));
        if (sha256(cursor) !== state.cursorhash) return { status: "untrusted" };
        await input.verifier.verifyOwnedSnapshot(state.current);
        if (sha256(await readPrivateRegularFile(committedCursorPath(input.storeRoot))) !== state.cursorhash) {
            return { status: "untrusted" };
        }
        return { status: "trusted", current: state.current, coverage: state.coverage };
    } catch {
        return { status: "untrusted" };
    }
}

export async function publishWorkspaceTrackerState(input: {
    storeRoot: string;
    workspaceIdentity: string;
    workspaceIncarnation: string;
    current: WorkspaceSnapshotRefV1;
    coverage: WorkspaceSnapshotCoverage | Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">;
}): Promise<void> {
    validateLocation(input.storeRoot, input.workspaceIdentity, input.workspaceIncarnation);
    if (
        input.current.workspaceIdentity !== input.workspaceIdentity ||
        input.current.workspaceIncarnation !== input.workspaceIncarnation
    ) {
        throw new Error("Workspace tracker snapshot identity mismatch");
    }
    validateSnapshot(input.current);
    const cursorPath = committedCursorPath(input.storeRoot);
    const cursorHash = sha256(await readPrivateRegularFile(cursorPath));
    const coverage = cloneCoverage(input.coverage);
    const wire = {
        schemaversion: 1,
        workspaceidentity: input.workspaceIdentity,
        workspaceincarnation: input.workspaceIncarnation,
        current: {
            id: input.current.id,
            workspaceidentity: input.current.workspaceIdentity,
            workspaceincarnation: input.current.workspaceIncarnation,
            tree: input.current.tree,
            scopemanifest: input.current.scopeManifest,
        },
        coverage: {
            complete: coverage.complete,
            eligibleentrycount: coverage.eligibleEntryCount,
            exclusions: coverage.exclusions.map(toWireExclusion),
        },
        cursorhash: cursorHash,
    };
    await writeDurableJson(statePath(input.storeRoot), wire);
    if (sha256(await readPrivateRegularFile(cursorPath)) !== cursorHash) {
        throw new Error("Workspace tracker cursor changed during state publication");
    }
}

function decodeState(value: unknown): StoredWorkspaceTrackerStateV1 {
    if (
        !isRecord(value) ||
        !hasExactKeys(value, [
            "schemaversion",
            "workspaceidentity",
            "workspaceincarnation",
            "current",
            "coverage",
            "cursorhash",
        ])
    ) {
        throw new Error("Invalid workspace tracker state");
    }
    if (
        value.schemaversion !== 1 ||
        !IdentityPattern.test(value.workspaceidentity as string) ||
        !IdentityPattern.test(value.workspaceincarnation as string) ||
        !CursorHashPattern.test(value.cursorhash as string)
    ) {
        throw new Error("Invalid workspace tracker state");
    }
    const current = decodeSnapshot(value.current);
    const coverage = decodeCoverage(value.coverage);
    return {
        schemaversion: 1,
        workspaceidentity: value.workspaceidentity as string,
        workspaceincarnation: value.workspaceincarnation as string,
        current,
        coverage,
        cursorhash: value.cursorhash as string,
    };
}

function decodeSnapshot(value: unknown): WorkspaceSnapshotRefV1 {
    if (
        !isRecord(value) ||
        !hasExactKeys(value, ["id", "workspaceidentity", "workspaceincarnation", "tree", "scopemanifest"])
    ) {
        throw new Error("Invalid workspace tracker snapshot");
    }
    const snapshot: WorkspaceSnapshotRefV1 = {
        id: value.id as string,
        workspaceIdentity: value.workspaceidentity as string,
        workspaceIncarnation: value.workspaceincarnation as string,
        tree: value.tree as string,
        scopeManifest: value.scopemanifest as string,
    };
    validateSnapshot(snapshot);
    return snapshot;
}

function decodeCoverage(value: unknown): Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes"> {
    if (!isRecord(value) || !hasExactKeys(value, ["complete", "eligibleentrycount", "exclusions"])) {
        throw new Error("Invalid workspace tracker coverage");
    }
    if (
        typeof value.complete !== "boolean" ||
        !Number.isSafeInteger(value.eligibleentrycount) ||
        (value.eligibleentrycount as number) < 0 ||
        !Array.isArray(value.exclusions)
    ) {
        throw new Error("Invalid workspace tracker coverage");
    }
    return {
        complete: value.complete,
        eligibleEntryCount: value.eligibleentrycount as number,
        exclusions: value.exclusions.map(decodeExclusion),
    };
}

function decodeExclusion(value: unknown): WorkspaceSnapshotCoverageExclusion {
    if (
        !isRecord(value) ||
        typeof value.reason !== "string" ||
        !CoverageReasons.has(value.reason as WorkspaceCoverageReason)
    ) {
        throw new Error("Invalid workspace tracker exclusion");
    }
    if (hasExactKeys(value, ["path", "reason"]) && typeof value.path === "string") {
        validateWorkspaceRelativePath(value.path);
        return { path: value.path, reason: value.reason as WorkspaceCoverageReason };
    }
    if (hasExactKeys(value, ["pathbytesbase64", "reason"]) && typeof value.pathbytesbase64 === "string") {
        const bytes = Buffer.from(value.pathbytesbase64, "base64");
        if (bytes.length === 0 || bytes.toString("base64") !== value.pathbytesbase64) {
            throw new Error("Invalid workspace tracker exclusion");
        }
        return { pathBytesBase64: value.pathbytesbase64, reason: value.reason as WorkspaceCoverageReason };
    }
    if (
        hasExactKeys(value, ["scope", "reason"]) &&
        value.scope === "workspace-root" &&
        value.reason === "capture-budget"
    ) {
        return { scope: "workspace-root", reason: "capture-budget" };
    }
    throw new Error("Invalid workspace tracker exclusion");
}

function cloneCoverage(
    coverage: WorkspaceSnapshotCoverage | Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes">
): Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes"> {
    const decoded = decodeCoverage({
        complete: coverage.complete,
        eligibleentrycount: coverage.eligibleEntryCount,
        exclusions: coverage.exclusions.map(toWireExclusion),
    });
    return decoded;
}

function toWireExclusion(exclusion: WorkspaceSnapshotCoverageExclusion): Record<string, unknown> {
    if (exclusion.path != null) return { path: exclusion.path, reason: exclusion.reason };
    if (exclusion.pathBytesBase64 != null) {
        return { pathbytesbase64: exclusion.pathBytesBase64, reason: exclusion.reason };
    }
    return { scope: exclusion.scope, reason: exclusion.reason };
}

async function readPrivateRegularFile(path: string): Promise<Buffer> {
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || (before.mode & 0o077n) !== 0n) {
        throw new Error("Workspace tracker file is not private regular storage");
    }
    const bytes = await readFile(path);
    const after = await lstat(path, { bigint: true });
    if (
        !after.isFile() ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.birthtimeNs !== before.birthtimeNs ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        after.nlink !== 1n ||
        (after.mode & 0o077n) !== 0n
    ) {
        throw new Error("Workspace tracker file changed while reading");
    }
    return bytes;
}

function validateLocation(storeRoot: string, workspaceIdentity: string, workspaceIncarnation: string): void {
    if (!isAbsolute(storeRoot) || normalize(storeRoot) !== storeRoot) throw new Error("Invalid tracker store root");
    if (!IdentityPattern.test(workspaceIdentity) || !IdentityPattern.test(workspaceIncarnation)) {
        throw new Error("Invalid tracker workspace identity");
    }
}

function validateSnapshot(snapshot: WorkspaceSnapshotRefV1): void {
    if (
        !OidPattern.test(snapshot.id) ||
        !OidPattern.test(snapshot.tree) ||
        !OidPattern.test(snapshot.scopeManifest) ||
        snapshot.id.length !== snapshot.tree.length ||
        snapshot.id.length !== snapshot.scopeManifest.length ||
        !IdentityPattern.test(snapshot.workspaceIdentity) ||
        !IdentityPattern.test(snapshot.workspaceIncarnation)
    ) {
        throw new Error("Invalid workspace tracker snapshot");
    }
}

function statePath(storeRoot: string): string {
    return join(storeRoot, "tracker", "state-v1.json");
}

function committedCursorPath(storeRoot: string): string {
    return join(storeRoot, "tracker", "committed.cursor");
}

function sha256(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[]): boolean {
    return (
        required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key))
    );
}
