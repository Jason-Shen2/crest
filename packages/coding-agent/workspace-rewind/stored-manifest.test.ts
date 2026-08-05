// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
    StoredManifestReader,
    type StoredManifestObjectReader,
    type StoredPathStateV1,
    type StoredScopeManifestV1,
    type StoredScopeManifestV2,
} from "./stored-manifest";
import type { CapturedPathStateV1, WorkspaceSnapshotRefV1 } from "./types";

const WorkspaceIdentity = "a".repeat(64);
const WorkspaceIncarnation = "b".repeat(64);
const EmptyTreeOid = "0".repeat(40);

describe("stored snapshot manifests", () => {
    test("reads equivalent file, executable, symlink, excluded, and absent states from v1 and v2", async () => {
        const states = new Map<string, CapturedPathStateV1>([
            ["README.md", { state: "file", oid: "1".repeat(40), executable: false }],
            ["bin/run", { state: "file", oid: "2".repeat(40), executable: true }],
            ["ignored.log", { state: "excluded", reason: "ignored" }],
            ["link", { state: "symlink", oid: "3".repeat(40) }],
        ]);
        const v1 = await makeV1Reader(states);
        const v2 = await makeV2Reader(states);

        for (const path of ["README.md", "bin/run", "link", "ignored.log", "missing.txt"]) {
            expect(await v2.readPathState(path)).toEqual(await v1.readPathState(path));
        }
    });

    test("reads leaf, tree, and absent node kinds only from a v2 state tree", async () => {
        const states = new Map<string, CapturedPathStateV1>([
            ["README.md", { state: "file", oid: "1".repeat(40), executable: false }],
            ["docs/guide.md", { state: "file", oid: "2".repeat(40), executable: false }],
        ]);
        const v1 = await makeV1Reader(states);
        const v2 = await makeV2Reader(states);

        await expect(v2.readNodeKind("README.md")).resolves.toBe("leaf");
        await expect(v2.readNodeKind("docs")).resolves.toBe("tree");
        await expect(v2.readNodeKind("missing")).resolves.toBe("absent");
        await expect(v2.readNodeKind("README.md/child")).rejects.toThrow(/traverses a leaf/i);
        await expect(v1.readNodeKind("README.md")).rejects.toThrow(/v2 base snapshot/i);
    });

    test("diffs v2 trees like v1 manifests while skipping equal Merkle subtrees", async () => {
        const before = new Map<string, CapturedPathStateV1>([
            ["README.md", { state: "file", oid: "1".repeat(40), executable: false }],
            ["bin/run", { state: "file", oid: "2".repeat(40), executable: true }],
            ["ignored.log", { state: "excluded", reason: "ignored" }],
            ["link", { state: "symlink", oid: "3".repeat(40) }],
        ]);
        const after = new Map<string, CapturedPathStateV1>([
            ["README.md", { state: "file", oid: "4".repeat(40), executable: false }],
            ["bin/run", { state: "file", oid: "2".repeat(40), executable: true }],
            ["ignored.log", { state: "excluded", reason: "ignored" }],
            ["new.txt", { state: "file", oid: "5".repeat(40), executable: false }],
        ]);
        const v1Before = await makeV1Reader(before);
        const v1After = await makeV1Reader(after);
        const sharedObjects = new MemoryObjects();
        const v2Before = await makeV2Reader(before, sharedObjects);
        const v2After = await makeV2Reader(after, sharedObjects);
        const binTreeOid = sharedObjects.pathTreeOids.get("bin");
        sharedObjects.treeReads.length = 0;

        expect(await v2Before.diff(v2After)).toEqual(await v1Before.diff(v1After));
        expect(sharedObjects.treeReads.filter((oid) => oid === binTreeOid)).toHaveLength(0);
    });

    test("rejects semantically valid manifest bytes that are not canonical", async () => {
        const objects = new MemoryObjects();
        const manifest = JSON.parse(canonicalJson(makeV1Manifest(new Map())).toString("utf8"));
        const manifestOid = objects.putBlob(Buffer.from(JSON.stringify(manifest, null, 2)));

        await expect(openReader(objects, manifestOid)).rejects.toThrow("Snapshot scope manifest is not canonical");
    });

    test("rejects a v2 manifest whose descriptor identity does not match", async () => {
        const objects = new MemoryObjects();
        const stateTree = objects.putStateTree(new Map());
        const manifestOid = objects.putBlob(canonicalJson(makeV2Manifest(stateTree)));

        await expect(
            StoredManifestReader.open({
                snapshot: makeSnapshot(manifestOid, { workspaceIdentity: "c".repeat(64) }),
                objects,
            })
        ).rejects.toThrow("Snapshot scope manifest identity mismatch");
    });

    test("rejects an invalid v2 state-tree oid", async () => {
        const objects = new MemoryObjects();
        const manifestOid = objects.putBlob(canonicalJson(makeV2Manifest("not-an-oid")));

        await expect(openReader(objects, manifestOid)).rejects.toThrow("Invalid snapshot scope manifest");
    });

    test("fails closed when a v2 state leaf has an invalid schema", async () => {
        const objects = new MemoryObjects();
        const invalidState = objects.putBlob(canonicalJson({ schemaversion: 2, state: { state: "absent" } }));
        const stateTree = objects.putTree([{ name: "README.md", mode: "100644", oid: invalidState }]);
        const manifestOid = objects.putBlob(canonicalJson(makeV2Manifest(stateTree)));
        const reader = await openReader(objects, manifestOid);

        await expect(reader.verify()).rejects.toThrow("Invalid stored path state");
    });

    test("rejects an explicit absent leaf because absence is represented by no leaf", async () => {
        const objects = new MemoryObjects();
        const absent = objects.putBlob(canonicalJson({ schemaversion: 1, state: { state: "absent" } }));
        const stateTree = objects.putTree([{ name: "missing.txt", mode: "100644", oid: absent }]);
        const manifestOid = objects.putBlob(canonicalJson(makeV2Manifest(stateTree)));
        const reader = await openReader(objects, manifestOid);

        await expect(reader.readPathState("missing.txt")).rejects.toThrow("absence must not be stored");
    });

    test("rejects a path state object id from a different Git hash format", async () => {
        const objects = new MemoryObjects();
        const state = objects.putBlob(
            canonicalJson({ schemaversion: 1, state: { state: "symlink", oid: "f".repeat(64) } })
        );
        const stateTree = objects.putTree([{ name: "link", mode: "100644", oid: state }]);
        const manifestOid = objects.putBlob(canonicalJson(makeV2Manifest(stateTree)));
        const reader = await openReader(objects, manifestOid);

        await expect(reader.verify()).rejects.toThrow("Invalid stored path state object id");
    });

    test("verifies 10k state leaves with bounded blob batches instead of one read per leaf", async () => {
        const objects = new MemoryObjects();
        const states = new Map<string, CapturedPathStateV1>();
        for (let index = 0; index < 10_000; index++) {
            states.set(`files/${index.toString().padStart(5, "0")}.txt`, {
                state: "file",
                oid: createHash("sha1").update(`content-${index}`).digest("hex"),
                executable: false,
            });
        }
        const reader = await makeV2Reader(states, objects);
        objects.blobReads.length = 0;
        objects.blobBatchReads.length = 0;

        await expect(reader.verify()).resolves.toMatchObject({ workspaceStates: { size: 10_000 } });
        expect(objects.blobReads).toHaveLength(0);
        expect(objects.blobBatchReads.length).toBeGreaterThan(1);
        expect(objects.blobBatchReads.length).toBeLessThanOrEqual(20);
        expect(objects.blobBatchReads.flat()).toHaveLength(10_000);
    });

    test("keeps canonical stored coverage wire fields lowercase and exposes normalized domain coverage", async () => {
        const objects = new MemoryObjects();
        const stateTree = objects.putStateTree(new Map());
        const manifest = makeV2Manifest(stateTree);
        manifest.coverage = {
            complete: false,
            eligibleentrycount: 7,
            exclusions: [{ pathbytesbase64: Buffer.from([0xff]).toString("base64"), reason: "non-utf8-path" }],
        };
        const manifestOid = objects.putBlob(canonicalJson(manifest));
        const reader = await openReader(objects, manifestOid);

        expect(reader.manifest).toMatchObject({
            coverage: {
                eligibleentrycount: 7,
                exclusions: [{ pathbytesbase64: "/w==", reason: "non-utf8-path" }],
            },
        });
        expect(reader.getCoverage()).toEqual({
            complete: false,
            eligibleEntryCount: 7,
            exclusions: [{ pathBytesBase64: "/w==", reason: "non-utf8-path" }],
        });
    });
});

async function makeV1Reader(states: ReadonlyMap<string, CapturedPathStateV1>): Promise<StoredManifestReader> {
    const objects = new MemoryObjects();
    const manifestOid = objects.putBlob(canonicalJson(makeV1Manifest(states)));
    return openReader(objects, manifestOid);
}

async function makeV2Reader(
    states: ReadonlyMap<string, CapturedPathStateV1>,
    objects = new MemoryObjects()
): Promise<StoredManifestReader> {
    const stateTree = objects.putStateTree(states);
    const manifestOid = objects.putBlob(canonicalJson(makeV2Manifest(stateTree)));
    return openReader(objects, manifestOid);
}

function openReader(objects: MemoryObjects, manifestOid: string): Promise<StoredManifestReader> {
    return StoredManifestReader.open({ snapshot: makeSnapshot(manifestOid), objects });
}

function makeSnapshot(scopeManifest: string, overrides: Partial<WorkspaceSnapshotRefV1> = {}): WorkspaceSnapshotRefV1 {
    return {
        id: "d".repeat(40),
        workspaceIdentity: WorkspaceIdentity,
        workspaceIncarnation: WorkspaceIncarnation,
        tree: EmptyTreeOid,
        scopeManifest,
        ...overrides,
    };
}

function makeV1Manifest(states: ReadonlyMap<string, CapturedPathStateV1>): StoredScopeManifestV1 {
    return {
        schemaversion: 1,
        workspaceidentity: WorkspaceIdentity,
        workspaceincarnation: WorkspaceIncarnation,
        scope: makeScope(),
        entries: [...states]
            .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
            .map(([path, state]) => ({ path, state })),
    };
}

function makeV2Manifest(stateTree: string): StoredScopeManifestV2 {
    return {
        schemaversion: 2,
        workspaceidentity: WorkspaceIdentity,
        workspaceincarnation: WorkspaceIncarnation,
        scope: makeScope(),
        coverage: { complete: false, eligibleentrycount: 3, exclusions: [] },
        statetree: stateTree,
    };
}

function makeScope(): StoredScopeManifestV1["scope"] {
    return {
        schemaVersion: 1,
        policy: {
            maxEntries: 200_000,
            maxUntrackedBytes: 2 * 1024 * 1024,
            gitGlobalExcludes: "disabled-by-isolated-runner",
        },
        ignoreInputs: [],
        nestedRepositoryBoundaries: [],
    };
}

class MemoryObjects implements StoredManifestObjectReader {
    readonly blobs = new Map<string, Buffer>();
    readonly trees = new Map<string, Buffer>();
    readonly treeReads: string[] = [];
    readonly blobReads: string[] = [];
    readonly blobBatchReads: string[][] = [];
    readonly pathTreeOids = new Map<string, string>();

    putBlob(bytes: Buffer): string {
        const oid = objectOid("blob", bytes);
        this.blobs.set(oid, bytes);
        return oid;
    }

    putTree(entries: Array<{ name: string; mode: "100644" | "40000"; oid: string }>): string {
        entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
        const bytes = Buffer.concat(
            entries.flatMap((entry) => [Buffer.from(`${entry.mode} ${entry.name}\0`), Buffer.from(entry.oid, "hex")])
        );
        const oid = objectOid("tree", bytes);
        this.trees.set(oid, bytes);
        return oid;
    }

    putStateTree(states: ReadonlyMap<string, CapturedPathStateV1>): string {
        const root = makeTestTreeNode();
        for (const [path, state] of states) {
            const segments = path.split("/");
            let node = root;
            for (const segment of segments.slice(0, -1)) {
                node.children.set(segment, node.children.get(segment) ?? makeTestTreeNode());
                node = node.children.get(segment)!;
            }
            const stored: StoredPathStateV1 = { schemaversion: 1, state };
            node.leaves.set(segments.at(-1)!, this.putBlob(canonicalJson(stored)));
        }
        return this.writeTestTreeNode(root, "");
    }

    async readBlob(oid: string): Promise<Buffer> {
        this.blobReads.push(oid);
        const bytes = this.blobs.get(oid);
        if (!bytes) throw new Error(`Missing blob: ${oid}`);
        return bytes;
    }

    async readBlobs(oids: readonly string[]): Promise<ReadonlyMap<string, Buffer>> {
        this.blobBatchReads.push([...oids]);
        return new Map(
            oids.map((oid) => {
                const bytes = this.blobs.get(oid);
                if (!bytes) throw new Error(`Missing blob: ${oid}`);
                return [oid, bytes];
            })
        );
    }

    async readTree(oid: string): Promise<Buffer> {
        this.treeReads.push(oid);
        const bytes = this.trees.get(oid);
        if (!bytes) throw new Error(`Missing tree: ${oid}`);
        return bytes;
    }

    writeTestTreeNode(node: TestTreeNode, path: string): string {
        const entries: Array<{ name: string; mode: "100644" | "40000"; oid: string }> = [];
        for (const [name, child] of node.children) {
            const childPath = path ? `${path}/${name}` : name;
            const oid = this.writeTestTreeNode(child, childPath);
            this.pathTreeOids.set(childPath, oid);
            entries.push({ name, mode: "40000", oid });
        }
        for (const [name, oid] of node.leaves) entries.push({ name, mode: "100644", oid });
        return this.putTree(entries);
    }
}

interface TestTreeNode {
    children: Map<string, TestTreeNode>;
    leaves: Map<string, string>;
}

function makeTestTreeNode(): TestTreeNode {
    return { children: new Map(), leaves: new Map() };
}

function objectOid(type: "blob" | "tree", bytes: Buffer): string {
    return createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
}

function canonicalJson(value: unknown): Buffer {
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
