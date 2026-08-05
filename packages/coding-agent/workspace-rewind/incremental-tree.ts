// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { encodeCanonicalStoredJson, validateWorkspaceRelativePath } from "./stored-manifest";
import type { CapturedPathStateV1 } from "./types";

export interface IncrementalPathMutation {
    path: string;
    state: CapturedPathStateV1;
}

export interface IncrementalTreeEntry {
    name: string;
    mode: "100644" | "100755" | "120000" | "040000";
    type: "blob" | "tree";
    oid: string;
}

export interface IncrementalTreeObjectAccess {
    readTree(oid: string): Promise<Buffer>;
    readBlob(oid: string): Promise<Buffer>;
    readObjectType(oid: string): Promise<"blob" | "tree">;
    writeBlob(bytes: Buffer): Promise<string>;
    writeTree(entries: IncrementalTreeEntry[]): Promise<string>;
}

export interface AppliedIncrementalTrees {
    workspaceTree: string;
    stateTree: string;
    objectIds: string[];
    /** Unique paths rewritten in either tree, deepest first; an empty path is the root. */
    writtenTreePaths: string[];
}

interface MutationNode {
    mutation?: IncrementalPathMutation;
    children: Map<string, MutationNode>;
}

interface ParsedTreeEntry {
    mode: "100644" | "100755" | "120000" | "40000";
    oid: string;
}

interface ApplyContext {
    objects: IncrementalTreeObjectAccess;
    hashBytes: number;
    objectIds: Set<string>;
    writtenTreePaths: Set<string>;
    treeBytes: Map<string, Buffer>;
}

type TreeKind = "workspace" | "state";

export function normalizeIncrementalMutations(mutations: IncrementalPathMutation[]): IncrementalPathMutation[] {
    const normalized = mutations.map((mutation) => {
        validateCanonicalUtf8Path(mutation.path);
        validateMutationState(mutation.state);
        return mutation;
    });
    normalized.sort((left, right) => compareBytes(left.path, right.path));
    for (let index = 1; index < normalized.length; index++) {
        const previous = normalized[index - 1]!;
        const current = normalized[index]!;
        if (previous.path === current.path) {
            throw new Error(`Duplicate incremental mutation path: ${current.path}`);
        }
        if (current.path.startsWith(`${previous.path}/`) && previous.state.state !== "absent") {
            throw new Error(`Incremental mutation ancestor leaf conflicts with descendant: ${previous.path}`);
        }
    }
    return normalized;
}

export async function applyIncrementalTrees(input: {
    baseWorkspaceTree: string;
    baseStateTree: string;
    mutations: IncrementalPathMutation[];
    objects: IncrementalTreeObjectAccess;
}): Promise<AppliedIncrementalTrees> {
    validateRootOid(input.baseWorkspaceTree);
    validateRootOid(input.baseStateTree);
    if (input.baseWorkspaceTree.length !== input.baseStateTree.length) {
        throw new Error("Incremental tree roots use different Git object formats");
    }
    const mutations = normalizeIncrementalMutations(input.mutations);
    const root = makeMutationTree(mutations);
    const context: ApplyContext = {
        objects: input.objects,
        hashBytes: input.baseWorkspaceTree.length / 2,
        objectIds: new Set(),
        writtenTreePaths: new Set(),
        treeBytes: new Map(),
    };
    const workspaceTree = await rewriteTree(input.baseWorkspaceTree, root, "workspace", "", context, true);
    const stateTree = await rewriteTree(input.baseStateTree, root, "state", "", context, true);
    return {
        workspaceTree: workspaceTree!,
        stateTree: stateTree!,
        objectIds: [...context.objectIds].sort(compareBytes),
        writtenTreePaths: [...context.writtenTreePaths].sort(compareTreePathsBottomUp),
    };
}

async function rewriteTree(
    baseOid: string | undefined,
    mutations: MutationNode,
    kind: TreeKind,
    path: string,
    context: ApplyContext,
    keepEmpty: boolean
): Promise<string | undefined> {
    const entries = baseOid ? await readTreeEntries(baseOid, kind, context) : new Map<string, ParsedTreeEntry>();
    for (const [name, childMutations] of mutations.children) {
        const childPath = path ? `${path}/${name}` : name;
        const existing = entries.get(name);
        const updated = await rewriteEntry(existing, childMutations, kind, childPath, context);
        if (!updated) {
            entries.delete(name);
            continue;
        }
        entries.set(name, updated);
    }
    if (!keepEmpty && entries.size === 0) return undefined;
    const records = [...entries].map(
        ([name, entry]): IncrementalTreeEntry => ({
            name,
            mode: entry.mode === "40000" ? "040000" : entry.mode,
            type: entry.mode === "40000" ? "tree" : "blob",
            oid: entry.oid,
        })
    );
    const expected = encodeTree(records, context.hashBytes);
    if (baseOid) {
        const baseBytes = context.treeBytes.get(baseOid)!;
        if (baseBytes.equals(expected)) return baseOid;
    }
    const oid = await context.objects.writeTree(records);
    await verifyWrittenObject(oid, "tree", expected, context);
    context.objectIds.add(oid);
    context.writtenTreePaths.add(path);
    return oid;
}

async function rewriteEntry(
    existing: ParsedTreeEntry | undefined,
    mutations: MutationNode,
    kind: TreeKind,
    path: string,
    context: ApplyContext
): Promise<ParsedTreeEntry | undefined> {
    const mutation = mutations.mutation;
    if (mutation && mutation.state.state !== "absent") {
        if (mutations.children.size !== 0) {
            throw new Error(`Incremental mutation ancestor leaf conflicts with descendant: ${path}`);
        }
        if (existing?.mode === "40000") {
            throw new Error(`Incremental tree cannot replace a tree with a leaf: ${path}`);
        }
        if (existing) await assertObjectType(existing.oid, "blob", context);
        return await makeLeaf(mutation!.state, kind, context);
    }
    if (mutation && mutations.children.size === 0) return undefined;
    if (existing && existing.mode !== "40000") {
        await assertObjectType(existing.oid, "blob", context);
        throw new Error(`Incremental tree cannot descend through a leaf: ${path}`);
    }
    const baseTree = mutation ? undefined : existing?.oid;
    const oid = await rewriteTree(baseTree, mutations, kind, path, context, false);
    return oid ? { mode: "40000", oid } : undefined;
}

async function makeLeaf(
    state: Exclude<CapturedPathStateV1, { state: "absent" }>,
    kind: TreeKind,
    context: ApplyContext
): Promise<ParsedTreeEntry | undefined> {
    if (kind === "workspace") {
        if (state.state === "excluded") return undefined;
        await assertObjectType(state.oid, "blob", context);
        context.objectIds.add(state.oid);
        return {
            mode: state.state === "symlink" ? "120000" : state.executable ? "100755" : "100644",
            oid: state.oid,
        };
    }
    const bytes = encodeCanonicalStoredJson({ schemaversion: 1, state });
    const oid = await context.objects.writeBlob(bytes);
    await verifyWrittenObject(oid, "blob", bytes, context);
    context.objectIds.add(oid);
    return { mode: "100644", oid };
}

async function readTreeEntries(
    oid: string,
    kind: TreeKind,
    context: ApplyContext
): Promise<Map<string, ParsedTreeEntry>> {
    validateObjectOid(oid, context.hashBytes);
    const bytes = await context.objects.readTree(oid);
    context.treeBytes.set(oid, bytes);
    const entries = parseTree(bytes, context.hashBytes);
    for (const [name, entry] of entries) {
        if (
            (kind === "state" && entry.mode !== "100644" && entry.mode !== "40000") ||
            (kind === "workspace" && !["100644", "100755", "120000", "40000"].includes(entry.mode))
        ) {
            throw new Error(`Incremental ${kind} tree has an invalid mode: ${name}`);
        }
    }
    return entries;
}

async function assertObjectType(oid: string, expected: "blob" | "tree", context: ApplyContext): Promise<void> {
    validateObjectOid(oid, context.hashBytes);
    if ((await context.objects.readObjectType(oid)) !== expected) {
        throw new Error(`Incremental tree object type mismatch for ${oid}`);
    }
}

async function verifyWrittenObject(
    oid: string,
    type: "blob" | "tree",
    expected: Buffer,
    context: ApplyContext
): Promise<void> {
    validateObjectOid(oid, context.hashBytes);
    await assertObjectType(oid, type, context);
    const actual = type === "blob" ? await context.objects.readBlob(oid) : await context.objects.readTree(oid);
    if (!actual.equals(expected)) {
        throw new Error(`Incremental tree ${type} write collision or corruption`);
    }
}

function makeMutationTree(mutations: readonly IncrementalPathMutation[]): MutationNode {
    const root: MutationNode = { children: new Map() };
    for (const mutation of mutations) {
        let node = root;
        for (const segment of mutation.path.split("/")) {
            let child = node.children.get(segment);
            if (!child) {
                child = { children: new Map() };
                node.children.set(segment, child);
            }
            node = child;
        }
        node.mutation = mutation;
    }
    return root;
}

function validateCanonicalUtf8Path(path: string): void {
    validateWorkspaceRelativePath(path);
    const bytes = Buffer.from(path, "utf8");
    if (bytes.toString("utf8") !== path) {
        throw new Error(`Invalid UTF-8 workspace-relative path: ${path}`);
    }
}

function validateMutationState(state: CapturedPathStateV1): void {
    const keys = Object.keys(state).sort();
    if (state.state === "absent" && keys.length === 1) return;
    if (state.state === "file") {
        if (keys.join("\0") === "executable\0oid\0state" && typeof state.executable === "boolean" && isOid(state.oid)) {
            return;
        }
    }
    if (state.state === "symlink" && keys.join("\0") === "oid\0state" && isOid(state.oid)) return;
    if (
        state.state === "excluded" &&
        keys.join("\0") === "reason\0state" &&
        [
            "ignored",
            "nested-repository",
            "oversized-untracked",
            "non-utf8-path",
            "hard-linked",
            "special-entry",
            "capture-budget",
        ].includes(state.reason)
    ) {
        return;
    }
    throw new Error("Invalid incremental path state");
}

function parseTree(bytes: Buffer, hashBytes: number): Map<string, ParsedTreeEntry> {
    const entries = new Map<string, ParsedTreeEntry>();
    let offset = 0;
    let previousSortKey: Buffer | undefined;
    while (offset < bytes.length) {
        const space = bytes.indexOf(0x20, offset);
        const nul = bytes.indexOf(0, space + 1);
        if (space <= offset || nul < space + 2 || nul + 1 + hashBytes > bytes.length) {
            throw new Error("Invalid incremental Git tree object");
        }
        const mode = bytes.subarray(offset, space).toString("ascii") as ParsedTreeEntry["mode"];
        if (!["100644", "100755", "120000", "40000"].includes(mode)) {
            throw new Error("Invalid incremental Git tree mode");
        }
        const nameBytes = bytes.subarray(space + 1, nul);
        const name = nameBytes.toString("utf8");
        validateTreeName(name, nameBytes);
        if (entries.has(name)) throw new Error("Duplicate incremental Git tree entry");
        const oid = bytes.subarray(nul + 1, nul + 1 + hashBytes).toString("hex");
        validateObjectOid(oid, hashBytes);
        const sortKey = Buffer.concat([nameBytes, mode === "40000" ? Buffer.from("/") : Buffer.alloc(0)]);
        if (previousSortKey && Buffer.compare(previousSortKey, sortKey) >= 0) {
            throw new Error("Incremental Git tree entries are not canonical");
        }
        previousSortKey = sortKey;
        entries.set(name, { mode, oid });
        offset = nul + 1 + hashBytes;
    }
    return entries;
}

function encodeTree(entries: readonly IncrementalTreeEntry[], hashBytes: number): Buffer {
    const records = [...entries].sort((left, right) => Buffer.compare(treeSortKey(left), treeSortKey(right)));
    const names = new Set<string>();
    return Buffer.concat(
        records.map((entry) => {
            const nameBytes = Buffer.from(entry.name, "utf8");
            validateTreeName(entry.name, nameBytes);
            if (names.has(entry.name)) throw new Error("Duplicate incremental Git tree entry");
            names.add(entry.name);
            validateObjectOid(entry.oid, hashBytes);
            if ((entry.type === "tree") !== (entry.mode === "040000")) {
                throw new Error("Incremental Git tree mode and type mismatch");
            }
            return Buffer.concat([
                Buffer.from(`${entry.mode.replace(/^0/, "")} `),
                nameBytes,
                Buffer.from([0]),
                Buffer.from(entry.oid, "hex"),
            ]);
        })
    );
}

function validateTreeName(name: string, bytes: Buffer): void {
    if (
        !name ||
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        name.includes("\\") ||
        name.includes("\0") ||
        !Buffer.from(name, "utf8").equals(bytes)
    ) {
        throw new Error("Invalid incremental Git tree name");
    }
}

function validateRootOid(oid: string): void {
    if (!isOid(oid)) throw new Error("Invalid incremental tree root object id");
}

function validateObjectOid(oid: string, hashBytes: number): void {
    if (!/^[0-9a-f]+$/.test(oid) || oid.length !== hashBytes * 2) {
        throw new Error("Invalid incremental tree object id");
    }
}

function isOid(oid: string): boolean {
    return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(oid);
}

function compareBytes(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function treeSortKey(entry: IncrementalTreeEntry): Buffer {
    return Buffer.from(entry.type === "tree" ? `${entry.name}/` : entry.name, "utf8");
}

function compareTreePathsBottomUp(left: string, right: string): number {
    const depth = (path: string) => (path ? path.split("/").length : 0);
    return depth(right) - depth(left) || compareBytes(left, right);
}
