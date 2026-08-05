// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute } from "node:path";

import type {
    CapturedPathStateV1,
    WorkspacePathChangeV1,
    WorkspaceSnapshotCoverage,
    WorkspaceSnapshotRefV1,
} from "./types";
import type { WorkspaceScopeManifest } from "./workspace-scope";

export interface StoredManifestEntry {
    path: string;
    state: CapturedPathStateV1;
}

export interface StoredScopeManifestV1 {
    schemaversion: 1;
    workspaceidentity: string;
    workspaceincarnation: string;
    scope: WorkspaceScopeManifest;
    entries: StoredManifestEntry[];
}

export interface StoredScopeManifestV2 {
    schemaversion: 2;
    workspaceidentity: string;
    workspaceincarnation: string;
    scope: WorkspaceScopeManifest;
    coverage: StoredSnapshotCoverage;
    statetree: string;
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

export interface StoredPathStateV1 {
    schemaversion: 1;
    state: CapturedPathStateV1;
}

export type StoredScopeManifest = StoredScopeManifestV1 | StoredScopeManifestV2;

export interface StoredManifestObjectReader {
    readBlob(oid: string): Promise<Buffer>;
    readBlobs(oids: readonly string[]): Promise<ReadonlyMap<string, Buffer>>;
    readTree(oid: string): Promise<Buffer>;
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
export const StoredManifestBlobBatchSize = 512;

export class StoredManifestReader {
    readonly manifest: StoredScopeManifest;
    readonly snapshot: WorkspaceSnapshotRefV1;
    readonly objects: StoredManifestObjectReader;
    readonly v1States?: ReadonlyMap<string, CapturedPathStateV1>;
    readonly treeEntries = new Map<string, Promise<Map<string, StoredTreeEntry>>>();
    readonly pathStates = new Map<string, Promise<CapturedPathStateV1>>();

    private constructor(input: {
        snapshot: WorkspaceSnapshotRefV1;
        manifest: StoredScopeManifest;
        objects: StoredManifestObjectReader;
    }) {
        this.snapshot = input.snapshot;
        this.manifest = input.manifest;
        this.objects = input.objects;
        if (input.manifest.schemaversion === 1) {
            this.v1States = new Map(input.manifest.entries.map((entry) => [entry.path, entry.state]));
        }
    }

    static async open(input: {
        snapshot: WorkspaceSnapshotRefV1;
        objects: StoredManifestObjectReader;
    }): Promise<StoredManifestReader> {
        validateOid(input.snapshot.scopeManifest);
        const bytes = await input.objects.readBlob(input.snapshot.scopeManifest);
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        if (!isStoredManifest(value)) {
            throw new Error("Invalid snapshot scope manifest");
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
        if (value.schemaversion === 2 && value.statetree.length !== input.snapshot.scopeManifest.length) {
            throw new Error("Invalid snapshot scope manifest");
        }
        return new StoredManifestReader({ ...input, manifest: value });
    }

    async readPathState(path: string): Promise<CapturedPathStateV1> {
        validateWorkspaceRelativePath(path);
        if (this.manifest.schemaversion === 1) {
            return resolveV1PathState(this.manifest, this.v1States!, path);
        }
        return await this.readV2PathState(path);
    }

    async readNodeKind(path: string): Promise<"absent" | "leaf" | "tree"> {
        validateWorkspaceRelativePath(path);
        if (this.manifest.schemaversion !== 2) {
            throw new Error("Incremental path capture requires a v2 base snapshot");
        }
        const segments = path.split("/");
        let treeOid = this.manifest.statetree;
        for (let index = 0; index < segments.length; index++) {
            const entry = (await this.readTreeEntries(treeOid)).get(segments[index]!);
            if (!entry) return "absent";
            if (entry.mode !== "40000") {
                if (index === segments.length - 1) return "leaf";
                throw new Error("Incremental base path traverses a leaf");
            }
            if (index === segments.length - 1) return "tree";
            treeOid = entry.oid;
        }
        return "absent";
    }

    async diff(after: StoredManifestReader): Promise<WorkspacePathChangeV1[]> {
        if (
            this.manifest.workspaceidentity !== after.manifest.workspaceidentity ||
            this.manifest.workspaceincarnation !== after.manifest.workspaceincarnation
        ) {
            throw new Error("Cannot diff snapshot manifests from different workspace incarnations");
        }
        const paths = new Set<string>();
        if (this.manifest.schemaversion === 2 && after.manifest.schemaversion === 2) {
            await collectDifferingV2Paths(this, after, this.manifest.statetree, after.manifest.statetree, "", paths);
        } else {
            await this.collectExplicitPaths(paths);
            await after.collectExplicitPaths(paths);
        }
        const changes: WorkspacePathChangeV1[] = [];
        for (const path of [...paths].sort(comparePathBytes)) {
            const beforeState = await this.readPathState(path);
            const afterState = await after.readPathState(path);
            if (encodeCanonicalStoredJson(beforeState).equals(encodeCanonicalStoredJson(afterState))) {
                continue;
            }
            changes.push({ path, before: beforeState, after: afterState });
        }
        return changes;
    }

    async verify(): Promise<StoredManifestVerification> {
        const workspaceStates = new Map<string, CapturedPathStateV1>();
        const objectIds = new Set<string>();
        if (this.manifest.schemaversion === 1) {
            for (const [path, state] of this.v1States!) {
                if (state.state === "file" || state.state === "symlink") {
                    workspaceStates.set(path, state);
                }
            }
            return { workspaceStates, objectIds };
        }
        const pathsByOid = new Map<string, string[]>();
        await this.walkV2LeafOids(
            this.manifest.statetree,
            "",
            async (path, oid) => {
                const paths = pathsByOid.get(oid) ?? [];
                paths.push(path);
                pathsByOid.set(oid, paths);
            },
            objectIds
        );
        const oids = [...pathsByOid.keys()];
        for (let start = 0; start < oids.length; start += StoredManifestBlobBatchSize) {
            const batch = oids.slice(start, start + StoredManifestBlobBatchSize);
            const blobs = await this.objects.readBlobs(batch);
            if (blobs.size !== batch.length || batch.some((oid) => !blobs.has(oid))) {
                throw new Error("Invalid stored path state blob batch");
            }
            for (const oid of batch) {
                const state = this.decodeStoredPathState(oid, blobs.get(oid)!);
                this.pathStates.set(oid, Promise.resolve(state));
                for (const path of pathsByOid.get(oid)!) {
                    if (state.state === "file" || state.state === "symlink") {
                        workspaceStates.set(path, state);
                    }
                }
            }
        }
        return { workspaceStates, objectIds };
    }

    getCoverage(): Omit<WorkspaceSnapshotCoverage, "newlyHashedBytes"> | undefined {
        if (this.manifest.schemaversion === 1) return undefined;
        return {
            complete: this.manifest.coverage.complete,
            eligibleEntryCount: this.manifest.coverage.eligibleentrycount,
            exclusions: this.manifest.coverage.exclusions.map(normalizeCoverageExclusion),
        };
    }

    withV2StateTree(snapshot: WorkspaceSnapshotRefV1, stateTree: string): StoredManifestReader {
        if (this.manifest.schemaversion !== 2) {
            throw new Error("Incremental snapshot commit requires a v2 base snapshot");
        }
        validateOid(stateTree);
        if (stateTree.length !== snapshot.tree.length) {
            throw new Error("Invalid incremental snapshot state tree");
        }
        return new StoredManifestReader({
            snapshot,
            objects: this.objects,
            manifest: { ...this.manifest, statetree: stateTree },
        });
    }

    async collectExplicitPaths(paths: Set<string>): Promise<void> {
        if (this.manifest.schemaversion === 1) {
            for (const path of this.v1States!.keys()) paths.add(path);
            return;
        }
        await this.walkV2LeafOids(this.manifest.statetree, "", async (path) => {
            paths.add(path);
        });
    }

    async readV2PathState(path: string): Promise<CapturedPathStateV1> {
        const segments = path.split("/");
        let treeOid = this.manifest.schemaversion === 2 ? this.manifest.statetree : "";
        for (let index = 0; index < segments.length; index++) {
            const entries = await this.readTreeEntries(treeOid);
            const entry = entries.get(segments[index]!);
            if (!entry) return this.defaultPathState();
            if (entry.mode === "40000") {
                if (index === segments.length - 1) return this.defaultPathState();
                treeOid = entry.oid;
                continue;
            }
            const state = await this.readStoredPathState(entry.oid);
            if (index === segments.length - 1 || state.state === "excluded") return state;
            return this.defaultPathState();
        }
        return this.defaultPathState();
    }

    async walkV2LeafOids(
        treeOid: string,
        parentPath: string,
        visitor: (path: string, oid: string) => Promise<void>,
        objectIds?: Set<string>
    ): Promise<void> {
        objectIds?.add(treeOid);
        const entries = await this.readTreeEntries(treeOid);
        for (const [name, entry] of entries) {
            const path = parentPath ? `${parentPath}/${name}` : name;
            if (entry.mode === "40000") {
                await this.walkV2LeafOids(entry.oid, path, visitor, objectIds);
                continue;
            }
            objectIds?.add(entry.oid);
            await visitor(path, entry.oid);
        }
    }

    async readTreeEntries(treeOid: string): Promise<Map<string, StoredTreeEntry>> {
        validateOid(treeOid);
        const cached = this.treeEntries.get(treeOid);
        if (cached) return await cached;
        const reading = this.objects
            .readTree(treeOid)
            .then((bytes) => parseStateTreeEntries(bytes, treeOid.length / 2));
        this.treeEntries.set(treeOid, reading);
        return await reading;
    }

    async readStoredPathState(oid: string): Promise<CapturedPathStateV1> {
        validateOid(oid);
        const cached = this.pathStates.get(oid);
        if (cached) return await cached;
        const reading = this.readStoredPathStateUncached(oid);
        this.pathStates.set(oid, reading);
        return await reading;
    }

    async readStoredPathStateUncached(oid: string): Promise<CapturedPathStateV1> {
        const bytes = await this.objects.readBlob(oid);
        return this.decodeStoredPathState(oid, bytes);
    }

    decodeStoredPathState(oid: string, bytes: Buffer): CapturedPathStateV1 {
        let value: unknown;
        try {
            value = JSON.parse(bytes.toString("utf8"));
        } catch (cause) {
            throw new Error("Invalid stored path state", { cause });
        }
        if (!isStoredPathState(value)) {
            throw new Error("Invalid stored path state");
        }
        if (value.state.state === "absent") {
            throw new Error("Invalid stored path state: absence must not be stored");
        }
        if (
            (value.state.state === "file" || value.state.state === "symlink") &&
            value.state.oid.length !== this.snapshot.tree.length
        ) {
            throw new Error("Invalid stored path state object id");
        }
        if (!encodeCanonicalStoredJson(value).equals(bytes)) {
            throw new Error("Stored path state is not canonical");
        }
        return value.state;
    }

    defaultPathState(): CapturedPathStateV1 {
        if (scopeHasBudgetExhaustion(this.manifest.scope)) {
            return { state: "excluded", reason: "capture-budget" };
        }
        return { state: "absent" };
    }
}

async function collectDifferingV2Paths(
    before: StoredManifestReader,
    after: StoredManifestReader,
    beforeTreeOid: string | undefined,
    afterTreeOid: string | undefined,
    parentPath: string,
    paths: Set<string>
): Promise<void> {
    if (beforeTreeOid === afterTreeOid) return;
    if (!beforeTreeOid) {
        await after.walkV2LeafOids(afterTreeOid!, parentPath, async (path) => {
            paths.add(path);
        });
        return;
    }
    if (!afterTreeOid) {
        await before.walkV2LeafOids(beforeTreeOid, parentPath, async (path) => {
            paths.add(path);
        });
        return;
    }
    const [beforeEntries, afterEntries] = await Promise.all([
        before.readTreeEntries(beforeTreeOid),
        after.readTreeEntries(afterTreeOid),
    ]);
    const names = new Set([...beforeEntries.keys(), ...afterEntries.keys()]);
    for (const name of [...names].sort(comparePathBytes)) {
        const path = parentPath ? `${parentPath}/${name}` : name;
        const beforeEntry = beforeEntries.get(name);
        const afterEntry = afterEntries.get(name);
        if (beforeEntry?.mode === "40000" && afterEntry?.mode === "40000") {
            await collectDifferingV2Paths(before, after, beforeEntry.oid, afterEntry.oid, path, paths);
            continue;
        }
        if (beforeEntry?.mode === afterEntry?.mode && beforeEntry?.oid === afterEntry?.oid) continue;
        if (beforeEntry?.mode === "40000") {
            await before.walkV2LeafOids(beforeEntry.oid, path, async (nestedPath) => {
                paths.add(nestedPath);
            });
        } else if (beforeEntry) {
            paths.add(path);
        }
        if (afterEntry?.mode === "40000") {
            await after.walkV2LeafOids(afterEntry.oid, path, async (nestedPath) => {
                paths.add(nestedPath);
            });
        } else if (afterEntry) {
            paths.add(path);
        }
    }
}

function resolveV1PathState(
    manifest: StoredScopeManifestV1,
    states: ReadonlyMap<string, CapturedPathStateV1>,
    path: string
): CapturedPathStateV1 {
    const direct = states.get(path);
    if (direct) return direct;
    let parent = path;
    while (parent.includes("/")) {
        parent = parent.slice(0, parent.lastIndexOf("/"));
        const state = states.get(parent);
        if (state?.state === "excluded") return state;
    }
    if (scopeHasBudgetExhaustion(manifest.scope)) return { state: "excluded", reason: "capture-budget" };
    return { state: "absent" };
}

function isStoredManifest(value: unknown): value is StoredScopeManifest {
    if (!isJsonRecord(value)) return false;
    if (
        typeof value.workspaceidentity !== "string" ||
        typeof value.workspaceincarnation !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.workspaceidentity) ||
        !/^[0-9a-f]{64}$/.test(value.workspaceincarnation) ||
        !isStoredScope(value.scope)
    ) {
        return false;
    }
    if (value.schemaversion === 1) return isStoredManifestV1(value);
    if (value.schemaversion === 2) return isStoredManifestV2(value);
    return false;
}

function isStoredManifestV1(value: Record<string, unknown>): boolean {
    if (
        !hasExactKeys(value, ["schemaversion", "workspaceidentity", "workspaceincarnation", "scope", "entries"]) ||
        !Array.isArray(value.entries)
    ) {
        return false;
    }
    const seen = new Set<string>();
    let previousPath: string | undefined;
    for (const item of value.entries) {
        if (!isJsonRecord(item) || !hasExactKeys(item, ["path", "state"])) return false;
        if (typeof item.path !== "string" || seen.has(item.path) || !isCapturedPathState(item.state)) return false;
        try {
            validateWorkspaceRelativePath(item.path);
        } catch {
            return false;
        }
        if (previousPath != null && comparePathBytes(previousPath, item.path) >= 0) return false;
        seen.add(item.path);
        previousPath = item.path;
    }
    return true;
}

function isStoredManifestV2(value: Record<string, unknown>): boolean {
    return (
        hasExactKeys(value, [
            "schemaversion",
            "workspaceidentity",
            "workspaceincarnation",
            "scope",
            "coverage",
            "statetree",
        ]) &&
        typeof value.statetree === "string" &&
        isOid(value.statetree) &&
        isStoredCoverage(value.coverage)
    );
}

function isStoredPathState(value: unknown): value is StoredPathStateV1 {
    return (
        isJsonRecord(value) &&
        hasExactKeys(value, ["schemaversion", "state"]) &&
        value.schemaversion === 1 &&
        isCapturedPathState(value.state)
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

function isCapturedPathState(value: unknown): value is CapturedPathStateV1 {
    if (!isJsonRecord(value)) return false;
    if (value.state === "absent") return Object.keys(value).length === 1;
    if (value.state === "file") {
        return (
            hasExactKeys(value, ["state", "oid", "executable"]) &&
            typeof value.executable === "boolean" &&
            typeof value.oid === "string" &&
            isOid(value.oid)
        );
    }
    if (value.state === "symlink") {
        return hasExactKeys(value, ["state", "oid"]) && typeof value.oid === "string" && isOid(value.oid);
    }
    return (
        value.state === "excluded" &&
        hasExactKeys(value, ["state", "reason"]) &&
        typeof value.reason === "string" &&
        CoverageReasons.has(value.reason)
    );
}

interface StoredTreeEntry {
    mode: "100644" | "40000";
    oid: string;
}

function parseStateTreeEntries(value: Buffer, hashBytes: number): Map<string, StoredTreeEntry> {
    if (hashBytes !== 20 && hashBytes !== 32) throw new Error("Unsupported Git object format");
    const entries = new Map<string, StoredTreeEntry>();
    let offset = 0;
    while (offset < value.length) {
        const space = value.indexOf(0x20, offset);
        const nul = value.indexOf(0x00, space + 1);
        if (space <= offset || nul < space + 2 || nul + 1 + hashBytes > value.length) {
            throw new Error("Invalid state tree object");
        }
        const mode = value.subarray(offset, space).toString("ascii");
        if (mode !== "100644" && mode !== "40000") throw new Error("Invalid state tree mode");
        const nameBytes = value.subarray(space + 1, nul);
        const name = nameBytes.toString("utf8");
        if (
            !name ||
            name === "." ||
            name === ".." ||
            name.includes("/") ||
            name.includes("\\") ||
            !Buffer.from(name).equals(nameBytes) ||
            entries.has(name)
        ) {
            throw new Error("Invalid state tree name");
        }
        entries.set(name, {
            mode,
            oid: value.subarray(nul + 1, nul + 1 + hashBytes).toString("hex"),
        });
        offset = nul + 1 + hashBytes;
    }
    return entries;
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

function scopeHasBudgetExhaustion(scope: WorkspaceScopeManifest): boolean {
    return Object.hasOwn(scope as unknown as Record<string, unknown>, "budgetexhaustion");
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

function comparePathBytes(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
