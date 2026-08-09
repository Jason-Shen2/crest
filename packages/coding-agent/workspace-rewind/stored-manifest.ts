// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { dirname, isAbsolute } from "node:path";

import type { CapturedPathStateV1, WorkspaceSnapshotCoverage, WorkspaceSnapshotRefV1 } from "./types";
import type { WorkspaceScopeManifest } from "./workspace-scope";

export interface StoredScopeManifest {
    schemaversion: 3;
    workspaceidentity: string;
    workspaceincarnation: string;
    scope: StoredWorkspaceScopeManifestV1;
    coverage: StoredSnapshotCoverage;
}

export interface StoredSnapshotCoverage {
    complete: boolean;
    eligibleentrycount: number;
    exclusions: StoredSnapshotCoverageExclusion[];
}

export type StoredSnapshotCoverageExclusion =
    | { path: string; reason: WorkspaceSnapshotCoverage["exclusions"][number]["reason"] }
    | { pathbytesbase64: string; reason: WorkspaceSnapshotCoverage["exclusions"][number]["reason"] }
    | { scope: "workspace-root"; reason: "capture-budget" };

export type StoredWorkspaceScopeManifestPath =
    | { path: string; pathbytesbase64?: never }
    | { path?: never; pathbytesbase64: string };

export type StoredWorkspaceScopeIgnoreInput = StoredWorkspaceScopeManifestPath & {
    source: "gitignore" | "git-info-exclude" | "git-core-excludes-file";
    contenthash: string;
};

export interface StoredWorkspaceScopeSerializedIdentity {
    dev: string;
    ino: string;
    birthtimens: string;
    mtimens: string;
    ctimens: string;
}

export interface StoredWorkspaceScopeSerializedEntryIdentity extends StoredWorkspaceScopeSerializedIdentity {
    mode: string;
    nlink: string;
    size: string;
}

export interface StoredWorkspaceScopeGitIndexEvidence {
    path: string;
    parentpath: string;
    parentidentity: StoredWorkspaceScopeSerializedIdentity;
    state: "absent" | "file";
    entryidentity?: StoredWorkspaceScopeSerializedEntryIdentity;
    contenthash?: string;
}

export interface StoredWorkspaceScopeManifestV1 {
    schemaversion: 1;
    policy: {
        maxentries: number;
        maxuntrackedbytes: number;
        gitglobalexcludes: "disabled-by-isolated-runner";
    };
    ignoreinputs: StoredWorkspaceScopeIgnoreInput[];
    nestedrepositoryboundaries: StoredWorkspaceScopeManifestPath[];
    gitindex?: StoredWorkspaceScopeGitIndexEvidence;
    budgetexhaustion?: { scope: "workspace-root" };
}

export interface StoredManifestObjectReader {
    readBlob(oid: string): Promise<Buffer>;
}

export interface StoredManifestVerification {
    workspaceStates: ReadonlyMap<string, CapturedPathStateV1>;
    objectIds: ReadonlySet<string>;
}

const CoverageReasons = new Set([
    "ignored",
    "nested-repository",
    "oversized-untracked",
    "non-utf8-path",
    "hard-linked",
    "special-entry",
    "capture-budget",
]);

export class StoredManifestReader {
    readonly manifest: StoredScopeManifest;
    readonly snapshot: WorkspaceSnapshotRefV1;

    private constructor(input: { snapshot: WorkspaceSnapshotRefV1; manifest: StoredScopeManifest }) {
        this.snapshot = input.snapshot;
        this.manifest = input.manifest;
    }

    static async open(input: {
        snapshot: WorkspaceSnapshotRefV1;
        objects: StoredManifestObjectReader;
    }): Promise<StoredManifestReader> {
        validateOid(input.snapshot.scopeManifest);
        const bytes = await input.objects.readBlob(input.snapshot.scopeManifest);
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        if (!isStoredManifest(value)) {
            throw new Error("Invalid or unsupported v3 snapshot scope manifest");
        }
        if (!encodeCanonicalStoredJson(value).equals(bytes)) {
            throw new Error("Snapshot scope manifest is not canonical");
        }
        if (
            value.workspaceidentity !== input.snapshot.workspaceIdentity ||
            value.workspaceincarnation !== input.snapshot.workspaceIncarnation
        ) {
            throw new Error("Snapshot scope manifest identity mismatch");
        }
        return new StoredManifestReader({ snapshot: input.snapshot, manifest: value });
    }

    async readCoveragePathState(path: string): Promise<Extract<CapturedPathStateV1, { state: "absent" | "excluded" }>> {
        validateWorkspaceRelativePath(path);
        let candidate = path;
        while (true) {
            const exclusion = this.manifest.coverage.exclusions.find(
                (item): item is Extract<StoredSnapshotCoverageExclusion, { path: string }> =>
                    "path" in item && item.path === candidate
            );
            if (exclusion) return { state: "excluded", reason: exclusion.reason };
            const separator = candidate.lastIndexOf("/");
            if (separator < 0) break;
            candidate = candidate.slice(0, separator);
        }
        if (
            this.manifest.coverage.exclusions.some(
                (item) => "scope" in item && item.scope === "workspace-root" && item.reason === "capture-budget"
            )
        ) {
            return { state: "excluded", reason: "capture-budget" };
        }
        return { state: "absent" };
    }

    async verify(): Promise<StoredManifestVerification> {
        return { workspaceStates: new Map(), objectIds: new Set() };
    }

    getCoverage(): Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes"> {
        return {
            complete: this.manifest.coverage.complete,
            eligibleEntryCount: this.manifest.coverage.eligibleentrycount,
            exclusions: this.manifest.coverage.exclusions.map(normalizeCoverageExclusion),
        };
    }

    getScope(): WorkspaceScopeManifest {
        return normalizeStoredScope(this.manifest.scope);
    }
}

function isStoredManifest(value: unknown): value is StoredScopeManifest {
    return (
        isJsonRecord(value) &&
        value.schemaversion === 3 &&
        hasExactKeys(value, ["schemaversion", "workspaceidentity", "workspaceincarnation", "scope", "coverage"]) &&
        typeof value.workspaceidentity === "string" &&
        /^[0-9a-f]{64}$/.test(value.workspaceidentity) &&
        typeof value.workspaceincarnation === "string" &&
        /^[0-9a-f]{64}$/.test(value.workspaceincarnation) &&
        isStoredScope(value.scope) &&
        isStoredCoverage(value.coverage)
    );
}

function isStoredCoverage(value: unknown): boolean {
    if (
        !isJsonRecord(value) ||
        !hasExactKeys(value, ["complete", "eligibleentrycount", "exclusions"]) ||
        typeof value.complete !== "boolean" ||
        !Number.isSafeInteger(value.eligibleentrycount) ||
        (value.eligibleentrycount as number) < 0 ||
        !Array.isArray(value.exclusions)
    ) {
        return false;
    }
    return value.exclusions.every(isStoredCoverageExclusion);
}

function isStoredCoverageExclusion(value: unknown): boolean {
    if (!isJsonRecord(value) || typeof value.reason !== "string" || !CoverageReasons.has(value.reason)) return false;
    if (value.scope === "workspace-root") {
        return value.reason === "capture-budget" && hasExactKeys(value, ["scope", "reason"]);
    }
    if (Object.hasOwn(value, "path")) {
        if (!hasExactKeys(value, ["path", "reason"]) || typeof value.path !== "string") return false;
        try {
            validateWorkspaceRelativePath(value.path);
            return true;
        } catch {
            return false;
        }
    }
    if (!hasExactKeys(value, ["pathbytesbase64", "reason"]) || typeof value.pathbytesbase64 !== "string") {
        return false;
    }
    const bytes = Buffer.from(value.pathbytesbase64, "base64");
    return bytes.length > 0 && bytes.toString("base64") === value.pathbytesbase64;
}

function normalizeCoverageExclusion(
    value: StoredSnapshotCoverageExclusion
): WorkspaceSnapshotCoverage["exclusions"][number] {
    if ("scope" in value) return { scope: value.scope, reason: value.reason };
    if ("path" in value) return { path: value.path, reason: value.reason };
    return { pathBytesBase64: value.pathbytesbase64, reason: value.reason };
}

function normalizeStoredScope(value: unknown): WorkspaceScopeManifest {
    if (!isStoredScope(value)) throw new Error("Invalid snapshot scope manifest");
    const stored = value as StoredWorkspaceScopeManifestV1;
    return {
        schemaVersion: 1,
        policy: {
            maxEntries: stored.policy.maxentries,
            maxUntrackedBytes: stored.policy.maxuntrackedbytes,
            gitGlobalExcludes: stored.policy.gitglobalexcludes,
        },
        ignoreInputs: stored.ignoreinputs.map((item) => ({
            source: item.source,
            contentHash: item.contenthash,
            ...normalizeStoredManifestPath(item),
        })),
        nestedRepositoryBoundaries: stored.nestedrepositoryboundaries.map(normalizeStoredManifestPath),
        ...(stored.gitindex
            ? {
                  gitIndex: {
                      path: stored.gitindex.path,
                      parentPath: stored.gitindex.parentpath,
                      parentIdentity: normalizeStoredIdentity(stored.gitindex.parentidentity),
                      state: stored.gitindex.state,
                      ...(stored.gitindex.entryidentity
                          ? { entryIdentity: normalizeStoredEntryIdentity(stored.gitindex.entryidentity) }
                          : {}),
                      ...(stored.gitindex.contenthash ? { contentHash: stored.gitindex.contenthash } : {}),
                  },
              }
            : {}),
        ...(stored.budgetexhaustion ? { budgetExhaustion: { scope: stored.budgetexhaustion.scope } } : {}),
    };
}

function normalizeStoredManifestPath(value: {
    path?: string;
    pathbytesbase64?: string;
}): { path: string } | { pathBytesBase64: string } {
    if (value.path != null) return { path: value.path };
    return { pathBytesBase64: value.pathbytesbase64! };
}

function normalizeStoredIdentity(value: StoredWorkspaceScopeSerializedIdentity) {
    return {
        dev: value.dev,
        ino: value.ino,
        birthtimeNs: value.birthtimens,
        mtimeNs: value.mtimens,
        ctimeNs: value.ctimens,
    };
}

function normalizeStoredEntryIdentity(value: StoredWorkspaceScopeSerializedEntryIdentity) {
    return {
        ...normalizeStoredIdentity(value),
        mode: value.mode,
        nlink: value.nlink,
        size: value.size,
    };
}

export function toStoredWorkspaceScope(scope: WorkspaceScopeManifest): StoredWorkspaceScopeManifestV1 {
    return {
        schemaversion: 1,
        policy: {
            maxentries: scope.policy.maxEntries,
            maxuntrackedbytes: scope.policy.maxUntrackedBytes,
            gitglobalexcludes: scope.policy.gitGlobalExcludes,
        },
        ignoreinputs: scope.ignoreInputs.map((item) => ({
            source: item.source,
            contenthash: item.contentHash,
            ...toStoredManifestPath(item),
        })),
        nestedrepositoryboundaries: scope.nestedRepositoryBoundaries.map(toStoredManifestPath),
        ...(scope.gitIndex
            ? {
                  gitindex: {
                      path: scope.gitIndex.path,
                      parentpath: scope.gitIndex.parentPath,
                      parentidentity: toStoredIdentity(scope.gitIndex.parentIdentity),
                      state: scope.gitIndex.state,
                      ...(scope.gitIndex.entryIdentity
                          ? { entryidentity: toStoredEntryIdentity(scope.gitIndex.entryIdentity) }
                          : {}),
                      ...(scope.gitIndex.contentHash ? { contenthash: scope.gitIndex.contentHash } : {}),
                  },
              }
            : {}),
        ...(scope.budgetExhaustion ? { budgetexhaustion: { scope: scope.budgetExhaustion.scope } } : {}),
    };
}

function toStoredManifestPath(value: { path?: string; pathBytesBase64?: string }): StoredWorkspaceScopeManifestPath {
    if (value.path != null) return { path: value.path };
    return { pathbytesbase64: value.pathBytesBase64! };
}

function toStoredIdentity(value: {
    dev: string;
    ino: string;
    birthtimeNs: string;
    mtimeNs: string;
    ctimeNs: string;
}): StoredWorkspaceScopeSerializedIdentity {
    return {
        dev: value.dev,
        ino: value.ino,
        birthtimens: value.birthtimeNs,
        mtimens: value.mtimeNs,
        ctimens: value.ctimeNs,
    };
}

function toStoredEntryIdentity(value: {
    dev: string;
    ino: string;
    birthtimeNs: string;
    mtimeNs: string;
    ctimeNs: string;
    mode: string;
    nlink: string;
    size: string;
}): StoredWorkspaceScopeSerializedEntryIdentity {
    return {
        ...toStoredIdentity(value),
        mode: value.mode,
        nlink: value.nlink,
        size: value.size,
    };
}

function isStoredScope(value: unknown): boolean {
    if (
        !isJsonRecord(value) ||
        !hasExactKeys(
            value,
            ["schemaversion", "policy", "ignoreinputs", "nestedrepositoryboundaries"],
            ["budgetexhaustion", "gitindex"]
        )
    ) {
        return false;
    }
    if (
        value.schemaversion !== 1 ||
        !isJsonRecord(value.policy) ||
        !hasExactKeys(value.policy, ["maxentries", "maxuntrackedbytes", "gitglobalexcludes"]) ||
        !Number.isSafeInteger(value.policy.maxentries) ||
        (value.policy.maxentries as number) < 0 ||
        !Number.isSafeInteger(value.policy.maxuntrackedbytes) ||
        (value.policy.maxuntrackedbytes as number) < 0 ||
        value.policy.gitglobalexcludes !== "disabled-by-isolated-runner" ||
        !Array.isArray(value.ignoreinputs) ||
        !Array.isArray(value.nestedrepositoryboundaries)
    ) {
        return false;
    }
    if (
        value.budgetexhaustion != null &&
        (!isJsonRecord(value.budgetexhaustion) ||
            !hasExactKeys(value.budgetexhaustion, ["scope"]) ||
            value.budgetexhaustion.scope !== "workspace-root")
    ) {
        return false;
    }
    if (value.gitindex != null && !isStoredGitIndexEvidence(value.gitindex)) {
        return false;
    }
    if (
        !value.ignoreinputs.every(
            (item) =>
                isJsonRecord(item) &&
                hasExactKeys(item, ["source", "contenthash"], ["path", "pathbytesbase64"]) &&
                ["gitignore", "git-info-exclude", "git-core-excludes-file"].includes(item.source as string) &&
                typeof item.contenthash === "string" &&
                /^[0-9a-f]{64}$/.test(item.contenthash) &&
                hasOneValidManifestPath(item, item.source !== "gitignore")
        )
    ) {
        return false;
    }
    return value.nestedrepositoryboundaries.every(
        (item) =>
            isJsonRecord(item) &&
            hasExactKeys(item, [], ["path", "pathbytesbase64"]) &&
            hasOneValidManifestPath(item, false)
    );
}

function isStoredGitIndexEvidence(value: unknown): boolean {
    if (
        !isJsonRecord(value) ||
        !hasExactKeys(value, ["path", "parentpath", "parentidentity", "state"], ["entryidentity", "contenthash"]) ||
        typeof value.path !== "string" ||
        !isAbsolute(value.path) ||
        value.path.includes("\0") ||
        typeof value.parentpath !== "string" ||
        !isAbsolute(value.parentpath) ||
        value.parentpath.includes("\0") ||
        dirname(value.path) !== value.parentpath ||
        !isStoredSerializedIdentity(value.parentidentity, false)
    ) {
        return false;
    }
    if (value.state === "absent") {
        return !Object.hasOwn(value, "entryidentity") && !Object.hasOwn(value, "contenthash");
    }
    return (
        value.state === "file" &&
        isStoredSerializedIdentity(value.entryidentity, true) &&
        typeof value.contenthash === "string" &&
        /^[0-9a-f]{64}$/.test(value.contenthash)
    );
}

function isStoredSerializedIdentity(value: unknown, entry: boolean): boolean {
    if (!isJsonRecord(value)) return false;
    const directoryKeys = ["dev", "ino", "birthtimens", "mtimens", "ctimens"];
    const keys = entry ? [...directoryKeys, "mode", "nlink", "size"] : directoryKeys;
    return hasExactKeys(value, keys) && keys.every((key) => typeof value[key] === "string" && /^\d+$/.test(value[key]));
}

function hasOneValidManifestPath(value: Record<string, unknown>, allowAbsolute: boolean): boolean {
    const hasPath = Object.hasOwn(value, "path");
    const hasPathBytes = Object.hasOwn(value, "pathbytesbase64");
    if (hasPath === hasPathBytes) return false;
    if (hasPath) {
        if (typeof value.path !== "string") return false;
        if (allowAbsolute && isAbsolute(value.path) && !value.path.includes("\0")) return true;
        try {
            validateWorkspaceRelativePath(value.path);
            return true;
        } catch {
            return false;
        }
    }
    if (typeof value.pathbytesbase64 !== "string" || !value.pathbytesbase64) return false;
    const bytes = Buffer.from(value.pathbytesbase64, "base64");
    return bytes.length > 0 && bytes.toString("base64") === value.pathbytesbase64;
}

export function validateWorkspaceRelativePath(path: string): void {
    if (
        typeof path !== "string" ||
        !path ||
        path.includes("\0") ||
        path.includes("\\") ||
        isAbsolute(path) ||
        path.split("/").some((segment) => !segment || segment === "." || segment === "..")
    ) {
        throw new Error(`Invalid workspace-relative path: ${path}`);
    }
}

function validateOid(oid: string): void {
    if (!isOid(oid)) throw new Error("Invalid Git object id");
}

function isOid(value: string): boolean {
    return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
    const allowed = new Set([...required, ...optional]);
    return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

export function encodeCanonicalStoredJson(value: unknown): Buffer {
    return Buffer.from(JSON.stringify(sortJsonValue(value)));
}

function sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJsonValue);
    if (typeof value !== "object" || value == null) return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, item]) => [key.toLowerCase(), sortJsonValue(item)])
    );
}
