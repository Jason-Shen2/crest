// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute } from "node:path";

import type { WorkspaceGitRunner } from "./git-runner";
import { encodeCanonicalStoredJson, validateWorkspaceRelativePath } from "./stored-manifest";

const WorkspaceHeadRef = "refs/crest/workspace-head";
const ZeroOid = "0".repeat(40);
const GitTimeoutMs = 30_000;
const MaxCommitBytes = 64 * 1024;
const MutationKinds = new Set<WorkspaceMutationKind>([
    "external",
    "agent-turn",
    "turn-undo",
    "turn-redo",
    "rewind",
    "redo",
]);

export type WorkspaceMutationKind = "external" | "agent-turn" | "turn-undo" | "turn-redo" | "rewind" | "redo";

export interface WorkspaceMutationMetadataV1 {
    schemaversion: 1;
    workspaceidentity: string;
    workspaceincarnation: string;
    kind: WorkspaceMutationKind;
    sessionid?: string;
    turnid?: string;
    operationid?: string;
}

export interface ForeignOverlapInput {
    afterCommit: string;
    paths: readonly string[];
    includedCommits: ReadonlySet<string>;
    ownerSessionId: string;
}

export interface ForeignOverlap {
    commit: string;
    path: string;
    sessionId?: string;
}

export class WorkspaceMutationLog {
    readonly git: WorkspaceGitRunner;
    readonly gitDir: string;
    readonly workspaceIdentity: string;
    readonly workspaceIncarnation: string;

    constructor(input: {
        git: WorkspaceGitRunner;
        gitDir: string;
        workspaceIdentity: string;
        workspaceIncarnation: string;
    }) {
        if (
            !isAbsolute(input.gitDir) ||
            !isWorkspaceIdentity(input.workspaceIdentity) ||
            !isWorkspaceIdentity(input.workspaceIncarnation)
        ) {
            throw new Error("Invalid workspace mutation log identity");
        }
        this.git = input.git;
        this.gitDir = input.gitDir;
        this.workspaceIdentity = input.workspaceIdentity;
        this.workspaceIncarnation = input.workspaceIncarnation;
    }

    async readHead(): Promise<string | undefined> {
        const result = await this.git.run(
            ["for-each-ref", "--format=%(refname) %(objectname)", "--count=2", WorkspaceHeadRef],
            {
                gitDir: this.gitDir,
                timeoutMs: GitTimeoutMs,
                maxStdoutBytes: 1024,
            }
        );
        if (result.stdout.length === 0) {
            return undefined;
        }
        return decodeExactHead(result.stdout);
    }

    async append(input: {
        expectedHead?: string;
        tree: string;
        metadata: WorkspaceMutationMetadataV1;
    }): Promise<string> {
        validateSha1(input.tree);
        if (input.expectedHead != null) validateSha1(input.expectedHead);
        validateMetadata(input.metadata, this.workspaceIdentity, this.workspaceIncarnation);
        const metadata = encodeCanonicalStoredJson(input.metadata);
        const commitResult = await this.git.run(
            ["commit-tree", input.tree, ...(input.expectedHead == null ? [] : ["-p", input.expectedHead])],
            {
                gitDir: this.gitDir,
                stdin: metadata,
                timeoutMs: GitTimeoutMs,
                maxStdoutBytes: 128,
            }
        );
        const commit = decodeOidLine(commitResult.stdout);
        await this.git.run(["update-ref", WorkspaceHeadRef, commit, input.expectedHead ?? ZeroOid], {
            gitDir: this.gitDir,
            timeoutMs: GitTimeoutMs,
            maxStdoutBytes: 0,
        });
        return commit;
    }

    async read(commit: string): Promise<{
        parent?: string;
        tree: string;
        metadata: WorkspaceMutationMetadataV1;
    }> {
        validateSha1(commit);
        const result = await this.git.run(["cat-file", "commit", commit], {
            gitDir: this.gitDir,
            timeoutMs: GitTimeoutMs,
            maxStdoutBytes: MaxCommitBytes,
        });
        const separator = result.stdout.indexOf("\n\n");
        if (separator < 0) {
            throw new Error("Invalid workspace mutation commit");
        }
        const headers = decodeUtf8(result.stdout.subarray(0, separator), "commit headers").split("\n");
        const treeHeaders = headers.filter((line) => line.startsWith("tree "));
        const parentHeaders = headers.filter((line) => line.startsWith("parent "));
        if (treeHeaders.length !== 1 || treeHeaders[0] !== headers[0] || parentHeaders.length > 1) {
            throw new Error("Invalid workspace mutation commit chain");
        }
        const tree = treeHeaders[0].slice("tree ".length);
        const parent = parentHeaders[0]?.slice("parent ".length);
        validateSha1(tree);
        if (parent != null) validateSha1(parent);
        await requireObjectType(this.git, this.gitDir, tree, "tree", "tree");
        if (parent != null) {
            await requireObjectType(this.git, this.gitDir, parent, "commit", "parent");
        }
        const message = result.stdout.subarray(separator + 2);
        const metadata = decodeMetadata(message, this.workspaceIdentity, this.workspaceIncarnation);
        return { ...(parent == null ? {} : { parent }), tree, metadata };
    }

    async changedPaths(commit: string): Promise<string[]> {
        validateSha1(commit);
        const result = await this.git.run(
            ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", "--no-renames", commit],
            {
                gitDir: this.gitDir,
                timeoutMs: GitTimeoutMs,
            }
        );
        return decodePaths(result.stdout);
    }

    async findForeignOverlap(input: ForeignOverlapInput): Promise<ForeignOverlap[]> {
        validateSha1(input.afterCommit);
        if (typeof input.ownerSessionId !== "string" || !input.ownerSessionId) {
            throw new Error("Invalid owner Session id");
        }
        const paths = [...input.paths];
        const pathSet = new Set<string>();
        for (const path of paths) {
            validateWorkspaceRelativePath(path);
            pathSet.add(path);
        }
        const includedCommits = new Set<string>();
        for (const commit of input.includedCommits) {
            validateSha1(commit);
            includedCommits.add(commit);
        }
        const remainingIncluded = new Set(includedCommits);
        await this.read(input.afterCommit);
        const head = await this.readHead();
        if (!head) {
            throw new Error("Workspace mutation head is missing");
        }

        const overlaps: ForeignOverlap[] = [];
        const visited = new Set<string>();
        let cursor = head;
        while (cursor !== input.afterCommit) {
            if (visited.has(cursor)) {
                throw new Error("Invalid workspace mutation commit chain");
            }
            visited.add(cursor);
            const entry = await this.read(cursor);
            const changedPaths = await this.changedPaths(cursor);
            if (includedCommits.has(cursor)) {
                if (entry.metadata.kind === "external" || entry.metadata.sessionid !== input.ownerSessionId) {
                    throw new Error("Included commit is not owned by the owner Session");
                }
                remainingIncluded.delete(cursor);
            } else {
                for (const path of changedPaths) {
                    if (!pathSet.has(path)) continue;
                    overlaps.push({
                        commit: cursor,
                        path,
                        ...(entry.metadata.kind === "external" || entry.metadata.sessionid == null
                            ? {}
                            : { sessionId: entry.metadata.sessionid }),
                    });
                }
            }
            if (!entry.parent) {
                throw new Error("The requested mutation boundary is not in the workspace commit chain");
            }
            cursor = entry.parent;
        }
        if (remainingIncluded.size !== 0) {
            throw new Error("Included commit is outside the requested mutation suffix");
        }
        if ((await this.readHead()) !== head) {
            throw new Error("Workspace mutation head moved during overlap inspection");
        }
        return overlaps;
    }
}

async function requireObjectType(
    git: WorkspaceGitRunner,
    gitDir: string,
    oid: string,
    expectedType: "tree" | "commit",
    label: "tree" | "parent"
): Promise<void> {
    const result = await git.run(["cat-file", "-t", oid], {
        gitDir,
        timeoutMs: GitTimeoutMs,
        maxStdoutBytes: 16,
    });
    if (!result.stdout.equals(Buffer.from(`${expectedType}\n`))) {
        throw new Error(`Invalid workspace mutation ${label} object`);
    }
}

function decodeOidLine(value: Buffer): string {
    const match = /^([0-9a-f]{40})\n?$/.exec(value.toString("ascii"));
    if (!match) throw new Error("Invalid SHA-1 object id returned by Git");
    return match[1];
}

function decodeExactHead(value: Buffer): string | undefined {
    const text = decodeUtf8(value, "Git ref output");
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    let head: string | undefined;
    for (const line of lines) {
        const separator = line.indexOf(" ");
        if (separator < 1 || line.indexOf(" ", separator + 1) >= 0) {
            throw new Error("Invalid Git ref output");
        }
        const ref = line.slice(0, separator);
        const oid = line.slice(separator + 1);
        validateSha1(oid);
        if (ref !== WorkspaceHeadRef) continue;
        if (head) throw new Error("Duplicate workspace mutation head");
        head = oid;
    }
    return head;
}

function validateSha1(value: string): void {
    if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
        throw new Error("Invalid SHA-1 object id");
    }
}

function decodePaths(value: Buffer): string[] {
    if (value.length === 0) return [];
    if (value.at(-1) !== 0) throw new Error("Invalid Git path output");
    const paths: string[] = [];
    const seen = new Set<string>();
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        if (value[index] !== 0) continue;
        if (index === start) throw new Error("Invalid Git path output");
        const path = decodeUtf8(value.subarray(start, index), "workspace-relative path");
        validateWorkspaceRelativePath(path);
        if (seen.has(path)) throw new Error("Duplicate workspace-relative path returned by Git");
        seen.add(path);
        paths.push(path);
        start = index + 1;
    }
    paths.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    return paths;
}

function decodeMetadata(
    value: Buffer,
    workspaceIdentity: string,
    workspaceIncarnation: string
): WorkspaceMutationMetadataV1 {
    const text = decodeUtf8(value, "workspace mutation metadata");
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (cause) {
        throw new Error("Invalid workspace mutation metadata", { cause });
    }
    validateMetadata(parsed, workspaceIdentity, workspaceIncarnation);
    if (!encodeCanonicalStoredJson(parsed).equals(value)) {
        throw new Error("Workspace mutation metadata is not canonical");
    }
    return parsed;
}

function validateMetadata(
    value: unknown,
    workspaceIdentity: string,
    workspaceIncarnation: string
): asserts value is WorkspaceMutationMetadataV1 {
    if (!isJsonRecord(value)) throw new Error("Invalid workspace mutation metadata");
    const required = ["schemaversion", "workspaceidentity", "workspaceincarnation", "kind"];
    const optional = ["sessionid", "turnid", "operationid"];
    if (!hasExactKeys(value, required, optional)) {
        throw new Error("Invalid workspace mutation metadata keys");
    }
    if (
        value.schemaversion !== 1 ||
        !isWorkspaceIdentity(value.workspaceidentity) ||
        !isWorkspaceIdentity(value.workspaceincarnation) ||
        typeof value.kind !== "string" ||
        !MutationKinds.has(value.kind as WorkspaceMutationKind) ||
        !hasOptionalNonemptyString(value, "sessionid") ||
        !hasOptionalNonemptyString(value, "turnid") ||
        !hasOptionalNonemptyString(value, "operationid")
    ) {
        throw new Error("Invalid workspace mutation metadata");
    }
    if (value.workspaceidentity !== workspaceIdentity || value.workspaceincarnation !== workspaceIncarnation) {
        throw new Error("Workspace mutation metadata belongs to another workspace");
    }
}

function decodeUtf8(value: Buffer, label: string): string {
    const decoded = value.toString("utf8");
    if (!Buffer.from(decoded).equals(value)) throw new Error(`Invalid UTF-8 ${label}`);
    return decoded;
}

function isWorkspaceIdentity(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[]): boolean {
    const allowed = new Set([...required, ...optional]);
    return (
        required.every((key) => Object.hasOwn(value, key)) &&
        Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key))
    );
}

function hasOptionalNonemptyString(value: Record<string, unknown>, key: string): boolean {
    return !Object.hasOwn(value, key) || (typeof value[key] === "string" && value[key].length > 0);
}
