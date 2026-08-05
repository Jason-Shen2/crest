// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
    applyIncrementalTrees,
    normalizeIncrementalMutations,
    type IncrementalTreeEntry,
    type IncrementalTreeObjectAccess,
} from "./incremental-tree";
import { encodeCanonicalStoredJson } from "./stored-manifest";
import type { CapturedPathStateV1 } from "./types";

describe("incremental tree writer", () => {
    test("rewrites only affected ancestors and reuses untouched workspace and state subtrees", async () => {
        const objects = new MemoryObjects();
        const base = await makeBaseTrees(objects);
        const updated = objects.putBlob(Buffer.from("updated readme"));
        const baseWorkspaceDocs = await childTreeOid(objects, base.workspaceTree, "docs");
        const baseStateDocs = await childTreeOid(objects, base.stateTree, "docs");
        objects.treeReads.length = 0;

        const result = await applyIncrementalTrees({
            baseWorkspaceTree: base.workspaceTree,
            baseStateTree: base.stateTree,
            mutations: [{ path: "docs/README.md", state: file(updated) }],
            objects,
        });
        const writerReads = [...objects.treeReads];

        expect(result.workspaceTree).not.toBe(base.workspaceTree);
        expect(result.stateTree).not.toBe(base.stateTree);
        expect(await childTreeOid(objects, result.workspaceTree, "src")).toBe(
            await childTreeOid(objects, base.workspaceTree, "src")
        );
        expect(await childTreeOid(objects, result.workspaceTree, "assets")).toBe(
            await childTreeOid(objects, base.workspaceTree, "assets")
        );
        expect(await childTreeOid(objects, result.stateTree, "src")).toBe(
            await childTreeOid(objects, base.stateTree, "src")
        );
        expect(await childTreeOid(objects, result.stateTree, "assets")).toBe(
            await childTreeOid(objects, base.stateTree, "assets")
        );
        expect(result.writtenTreePaths).toEqual(["docs", ""]);
        const baseReads = writerReads.filter((oid) =>
            [base.workspaceTree, baseWorkspaceDocs, base.stateTree, baseStateDocs].includes(oid)
        );
        expect(baseReads).toEqual([base.workspaceTree, baseWorkspaceDocs, base.stateTree, baseStateDocs]);
    });

    test("applies create, write, delete, and rename as exact path mutations", async () => {
        const objects = new MemoryObjects();
        const base = await makeBaseTrees(objects);
        const created = objects.putBlob(Buffer.from("created"));
        const rewritten = objects.putBlob(Buffer.from("rewritten"));
        const renamed = objects.putBlob(Buffer.from("renamed"));

        const result = await applyIncrementalTrees({
            baseWorkspaceTree: base.workspaceTree,
            baseStateTree: base.stateTree,
            mutations: [
                { path: "created.txt", state: file(created) },
                { path: "docs/README.md", state: file(rewritten) },
                { path: "src/index.ts", state: { state: "absent" } },
                { path: "assets/logo.txt", state: { state: "absent" } },
                { path: "assets/renamed.txt", state: file(renamed) },
            ],
            objects,
        });

        expect(await workspaceLeaves(objects, result.workspaceTree)).toEqual(
            new Map([
                ["assets/renamed.txt", { mode: "100644", oid: renamed }],
                ["created.txt", { mode: "100644", oid: created }],
                ["docs/README.md", { mode: "100644", oid: rewritten }],
            ])
        );
        expect(await stateLeaves(objects, result.stateTree)).toEqual(
            new Map([
                ["assets/renamed.txt", file(renamed)],
                ["created.txt", file(created)],
                ["docs/README.md", file(rewritten)],
            ])
        );
    });

    test("preserves executable and symlink modes while excluded paths exist only in state", async () => {
        const objects = new MemoryObjects();
        const base = await makeBaseTrees(objects);
        const executable = objects.putBlob(Buffer.from("#!/bin/sh\n"));
        const link = objects.putBlob(Buffer.from("docs/README.md"));

        const result = await applyIncrementalTrees({
            baseWorkspaceTree: base.workspaceTree,
            baseStateTree: base.stateTree,
            mutations: [
                { path: "bin/run", state: file(executable, true) },
                { path: "latest", state: { state: "symlink", oid: link } },
                { path: "ignored.log", state: { state: "excluded", reason: "ignored" } },
            ],
            objects,
        });

        const workspace = await workspaceLeaves(objects, result.workspaceTree);
        expect(workspace.get("bin/run")).toEqual({ mode: "100755", oid: executable });
        expect(workspace.get("latest")).toEqual({ mode: "120000", oid: link });
        expect(workspace.has("ignored.log")).toBe(false);
        expect((await stateLeaves(objects, result.stateTree)).get("ignored.log")).toEqual({
            state: "excluded",
            reason: "ignored",
        });
    });

    test("deletes an existing directory subtree from both trees with an absent mutation", async () => {
        const objects = new MemoryObjects();
        const base = await makeBaseTrees(objects);

        const result = await applyIncrementalTrees({
            baseWorkspaceTree: base.workspaceTree,
            baseStateTree: base.stateTree,
            mutations: [{ path: "docs", state: { state: "absent" } }],
            objects,
        });

        expect((await workspaceLeaves(objects, result.workspaceTree)).has("docs/README.md")).toBe(false);
        expect((await stateLeaves(objects, result.stateTree)).has("docs/README.md")).toBe(false);
        expect(result.writtenTreePaths).toEqual([""]);
    });

    test.each([
        {
            name: "leaf to directory",
            mutations: (objects: MemoryObjects) => [
                { path: "docs/README.md/child", state: file(objects.putBlob(Buffer.from("child"))) },
            ],
        },
        {
            name: "directory to leaf",
            mutations: (objects: MemoryObjects) => [
                { path: "docs", state: file(objects.putBlob(Buffer.from("replacement"))) },
            ],
        },
    ])("hard-blocks a $name conversion", async ({ mutations }) => {
        const objects = new MemoryObjects();
        const base = await makeBaseTrees(objects);

        await expect(
            applyIncrementalTrees({
                baseWorkspaceTree: base.workspaceTree,
                baseStateTree: base.stateTree,
                mutations: mutations(objects),
                objects,
            })
        ).rejects.toThrow(/leaf.*descendant|tree.*leaf|path collision/i);
    });

    test("produces deterministic roots and object sets for every mutation order", async () => {
        const objects = new MemoryObjects();
        const base = await makeBaseTrees(objects);
        const alpha = objects.putBlob(Buffer.from("alpha"));
        const beta = objects.putBlob(Buffer.from("beta"));
        const mutations = [
            { path: "z/beta.txt", state: file(beta) },
            { path: "a/alpha.txt", state: file(alpha) },
            { path: "docs/README.md", state: { state: "absent" } as const },
        ];

        const forward = await applyIncrementalTrees({
            baseWorkspaceTree: base.workspaceTree,
            baseStateTree: base.stateTree,
            mutations,
            objects,
        });
        const reverse = await applyIncrementalTrees({
            baseWorkspaceTree: base.workspaceTree,
            baseStateTree: base.stateTree,
            mutations: [...mutations].reverse(),
            objects,
        });

        expect(reverse.workspaceTree).toBe(forward.workspaceTree);
        expect(reverse.stateTree).toBe(forward.stateTree);
        expect(reverse.objectIds).toEqual(forward.objectIds);
        expect(reverse.writtenTreePaths).toEqual(forward.writtenTreePaths);
    });

    test("fails closed on invalid base entry types and write collisions", async () => {
        const objects = new MemoryObjects();
        const blob = objects.putBlob(Buffer.from("blob"));
        const invalidBase = objects.putRawTree([{ name: "dir", mode: "040000", type: "tree", oid: blob }]);
        const stateTree = objects.putTree([]);

        await expect(
            applyIncrementalTrees({
                baseWorkspaceTree: invalidBase,
                baseStateTree: stateTree,
                mutations: [{ path: "dir/file", state: file(blob) }],
                objects,
            })
        ).rejects.toThrow(/object type|tree/i);

        const base = await makeBaseTrees(objects);
        objects.collideWrites = true;
        await expect(
            applyIncrementalTrees({
                baseWorkspaceTree: base.workspaceTree,
                baseStateTree: base.stateTree,
                mutations: [{ path: "new.txt", state: file(blob) }],
                objects,
            })
        ).rejects.toThrow(/collision|corrupt/i);
    });

    test("uses owned mutation state after asynchronous object access begins", async () => {
        const objects = new MemoryObjects();
        const base = await makeBaseTrees(objects);
        const original = objects.putBlob(Buffer.from("original"));
        const replacement = objects.putBlob(Buffer.from("replacement"));
        const state = file(original) as Extract<CapturedPathStateV1, { state: "file" }>;
        const gate = objects.gateNextTreeRead();

        const applying = applyIncrementalTrees({
            baseWorkspaceTree: base.workspaceTree,
            baseStateTree: base.stateTree,
            mutations: [{ path: "owned.txt", state }],
            objects,
        });
        await gate.started;
        state.oid = replacement;
        gate.release();
        const result = await applying;

        expect((await workspaceLeaves(objects, result.workspaceTree)).get("owned.txt")).toEqual({
            mode: "100644",
            oid: original,
        });
    });

    test.each([
        {
            name: "truncated object id",
            bytes: Buffer.concat([Buffer.from("100644 file\0"), Buffer.alloc(19)]),
        },
        {
            name: "illegal mode",
            bytes: Buffer.concat([Buffer.from("100600 file\0"), Buffer.alloc(20)]),
        },
        {
            name: "illegal name",
            bytes: Buffer.concat([Buffer.from("100644 ..\0"), Buffer.alloc(20)]),
        },
        {
            name: "duplicate name",
            bytes: Buffer.concat([
                Buffer.from("100644 same\0"),
                Buffer.alloc(20),
                Buffer.from("100644 same\0"),
                Buffer.alloc(20, 1),
            ]),
        },
        {
            name: "unsorted names",
            bytes: Buffer.concat([
                Buffer.from("100644 z\0"),
                Buffer.alloc(20),
                Buffer.from("100644 a\0"),
                Buffer.alloc(20, 1),
            ]),
        },
    ])("rejects an adversarial raw tree with $name", async ({ bytes }) => {
        const objects = new MemoryObjects();
        const invalid = objects.putObject("tree", bytes);

        await expect(
            applyIncrementalTrees({
                baseWorkspaceTree: invalid,
                baseStateTree: objects.putTree([]),
                mutations: [],
                objects,
            })
        ).rejects.toThrow(/invalid|duplicate|canonical/i);
    });

    test("rejects SHA-1 entries under a SHA-256 root", async () => {
        const objects = new MemoryObjects();
        const mixed = objects.putObject(
            "tree",
            Buffer.concat([Buffer.from("100644 file\0"), Buffer.alloc(20)]),
            "sha256"
        );
        const empty = objects.putObject("tree", Buffer.alloc(0), "sha256");

        await expect(
            applyIncrementalTrees({
                baseWorkspaceTree: mixed,
                baseStateTree: empty,
                mutations: [],
                objects,
            })
        ).rejects.toThrow(/invalid/i);
    });
});

describe("incremental mutation normalization", () => {
    test("sorts canonical UTF-8 paths by raw bytes", () => {
        const oid = "a".repeat(40);
        expect(
            normalizeIncrementalMutations([
                { path: "z", state: file(oid) },
                { path: "é", state: file(oid) },
                { path: "a", state: file(oid) },
            ]).map((mutation) => mutation.path)
        ).toEqual(["a", "z", "é"]);
    });

    test.each(["", "/absolute", "../escape", "a//b", "a/./b", "a\\b", "bad\0path", "\ud800"])(
        "rejects a non-canonical path %j",
        (path) => {
            expect(() => normalizeIncrementalMutations([{ path, state: { state: "absent" } }])).toThrow(
                /workspace-relative|utf-8/i
            );
        }
    );

    test("rejects duplicate paths and same-batch ancestor leaf conflicts", () => {
        expect(() =>
            normalizeIncrementalMutations([
                { path: "same", state: { state: "absent" } },
                { path: "same", state: { state: "absent" } },
            ])
        ).toThrow(/duplicate/i);
        expect(() =>
            normalizeIncrementalMutations([
                { path: "parent", state: { state: "excluded", reason: "ignored" } },
                { path: "parent/child", state: { state: "absent" } },
            ])
        ).toThrow(/ancestor.*descendant/i);
    });

    test("finds every ancestor leaf when raw-byte siblings are interleaved", () => {
        const oid = "a".repeat(40);
        expect(() =>
            normalizeIncrementalMutations([
                { path: "a/b", state: { state: "absent" } },
                { path: "a!", state: { state: "absent" } },
                { path: "a", state: file(oid) },
            ])
        ).toThrow(/ancestor.*descendant.*a/i);
        expect(() =>
            normalizeIncrementalMutations([
                { path: "root", state: { state: "absent" } },
                { path: "root/branch/child", state: { state: "absent" } },
                { path: "root/branch!", state: { state: "absent" } },
                { path: "root/branch", state: { state: "symlink", oid } },
            ])
        ).toThrow(/ancestor.*descendant.*root\/branch/i);
    });

    test("allows absent ancestors while preserving raw-byte output order", () => {
        expect(
            normalizeIncrementalMutations([
                { path: "root/branch/child", state: { state: "absent" } },
                { path: "root!", state: { state: "absent" } },
                { path: "root", state: { state: "absent" } },
                { path: "root/branch", state: { state: "absent" } },
            ]).map((mutation) => mutation.path)
        ).toEqual(["root", "root!", "root/branch", "root/branch/child"]);
    });
});

function file(oid: string, executable = false): CapturedPathStateV1 {
    return { state: "file", oid, executable };
}

async function makeBaseTrees(objects: MemoryObjects): Promise<{ workspaceTree: string; stateTree: string }> {
    const states = new Map<string, CapturedPathStateV1>([
        ["assets/logo.txt", file(objects.putBlob(Buffer.from("logo")))],
        ["docs/README.md", file(objects.putBlob(Buffer.from("readme")))],
        ["src/index.ts", file(objects.putBlob(Buffer.from("source")))],
    ]);
    return {
        workspaceTree: objects.putWorkspaceTree(states),
        stateTree: objects.putStateTree(states),
    };
}

async function childTreeOid(objects: MemoryObjects, oid: string, name: string): Promise<string> {
    const entry = parseTree(await objects.readTree(oid)).get(name);
    if (entry?.mode !== "40000") throw new Error(`Missing child tree ${name}`);
    return entry.oid;
}

async function workspaceLeaves(
    objects: MemoryObjects,
    root: string,
    parent = ""
): Promise<Map<string, { mode: string; oid: string }>> {
    const leaves = new Map<string, { mode: string; oid: string }>();
    for (const [name, entry] of parseTree(await objects.readTree(root))) {
        const path = parent ? `${parent}/${name}` : name;
        if (entry.mode === "40000") {
            for (const [nested, value] of await workspaceLeaves(objects, entry.oid, path)) leaves.set(nested, value);
        } else {
            leaves.set(path, entry);
        }
    }
    return leaves;
}

async function stateLeaves(
    objects: MemoryObjects,
    root: string,
    parent = ""
): Promise<Map<string, CapturedPathStateV1>> {
    const leaves = new Map<string, CapturedPathStateV1>();
    for (const [name, entry] of parseTree(await objects.readTree(root))) {
        const path = parent ? `${parent}/${name}` : name;
        if (entry.mode === "40000") {
            for (const [nested, value] of await stateLeaves(objects, entry.oid, path)) leaves.set(nested, value);
        } else {
            const stored = JSON.parse((await objects.readBlob(entry.oid)).toString("utf8")) as {
                state: CapturedPathStateV1;
            };
            leaves.set(path, stored.state);
        }
    }
    return leaves;
}

class MemoryObjects implements IncrementalTreeObjectAccess {
    readonly values = new Map<string, { type: "blob" | "tree"; bytes: Buffer }>();
    readonly treeReads: string[] = [];
    collideWrites = false;
    nextTreeReadGate?: { started: Promise<void>; releasePromise: Promise<void>; start(): void; release(): void };

    putBlob(bytes: Buffer): string {
        return this.put("blob", bytes);
    }

    putTree(entries: IncrementalTreeEntry[]): string {
        return this.put("tree", encodeTree(entries));
    }

    putRawTree(entries: IncrementalTreeEntry[]): string {
        return this.putTree(entries);
    }

    putWorkspaceTree(states: ReadonlyMap<string, CapturedPathStateV1>): string {
        return this.putPathTree(
            new Map(
                [...states].flatMap(([path, state]) => {
                    if (state.state !== "file" && state.state !== "symlink") return [];
                    return [
                        [
                            path,
                            {
                                mode: state.state === "symlink" ? "120000" : state.executable ? "100755" : "100644",
                                oid: state.oid,
                            },
                        ],
                    ] as const;
                })
            )
        );
    }

    putStateTree(states: ReadonlyMap<string, CapturedPathStateV1>): string {
        return this.putPathTree(
            new Map(
                [...states].flatMap(([path, state]) => {
                    if (state.state === "absent") return [];
                    return [
                        [
                            path,
                            {
                                mode: "100644",
                                oid: this.putBlob(encodeCanonicalStoredJson({ schemaversion: 1, state })),
                            },
                        ],
                    ] as const;
                })
            )
        );
    }

    putPathTree(
        leaves: ReadonlyMap<string, { mode: Exclude<IncrementalTreeEntry["mode"], "040000">; oid: string }>
    ): string {
        const root: TestNode = { children: new Map() };
        for (const [path, leaf] of leaves) {
            const segments = path.split("/");
            let node = root;
            for (const segment of segments.slice(0, -1)) {
                let child = node.children.get(segment);
                if (!child || "mode" in child) {
                    child = { children: new Map() };
                    node.children.set(segment, child);
                }
                node = child;
            }
            node.children.set(segments.at(-1)!, leaf);
        }
        return this.putNode(root);
    }

    putNode(node: TestNode): string {
        return this.putTree(
            [...node.children].map(([name, child]) =>
                "mode" in child
                    ? { name, mode: child.mode, type: "blob", oid: child.oid }
                    : { name, mode: "040000", type: "tree", oid: this.putNode(child) }
            )
        );
    }

    async readTree(oid: string): Promise<Buffer> {
        const gate = this.nextTreeReadGate;
        if (gate) {
            this.nextTreeReadGate = undefined;
            gate.start();
            await gate.releasePromise;
        }
        this.treeReads.push(oid);
        return this.read(oid, "tree");
    }

    async readBlob(oid: string): Promise<Buffer> {
        return this.read(oid, "blob");
    }

    async readObjectType(oid: string): Promise<"blob" | "tree"> {
        const value = this.values.get(oid);
        if (!value) throw new Error("missing object");
        return value.type;
    }

    async writeBlob(bytes: Buffer): Promise<string> {
        if (!this.collideWrites) return this.putBlob(bytes);
        return this.putBlob(Buffer.from("collision"));
    }

    async writeTree(entries: IncrementalTreeEntry[]): Promise<string> {
        if (!this.collideWrites) return this.putTree(entries);
        return this.putTree([]);
    }

    read(oid: string, type: "blob" | "tree"): Buffer {
        const value = this.values.get(oid);
        if (!value || value.type !== type) throw new Error(`invalid ${type} object`);
        return Buffer.from(value.bytes);
    }

    put(type: "blob" | "tree", bytes: Buffer): string {
        return this.putObject(type, bytes);
    }

    putObject(type: "blob" | "tree", bytes: Buffer, algorithm: "sha1" | "sha256" = "sha1"): string {
        const oid = createHash(algorithm).update(`${type} ${bytes.length}\0`).update(bytes).digest("hex");
        this.values.set(oid, { type, bytes: Buffer.from(bytes) });
        return oid;
    }

    gateNextTreeRead() {
        let start!: () => void;
        let release!: () => void;
        const gate = {
            started: new Promise<void>((resolve) => (start = resolve)),
            releasePromise: new Promise<void>((resolve) => (release = resolve)),
            start: () => start(),
            release: () => release(),
        };
        this.nextTreeReadGate = gate;
        return gate;
    }
}

interface TestNode {
    children: Map<string, TestNode | { mode: Exclude<IncrementalTreeEntry["mode"], "040000">; oid: string }>;
}

function encodeTree(entries: readonly IncrementalTreeEntry[]): Buffer {
    const sorted = [...entries].sort((left, right) => Buffer.compare(treeSortKey(left), treeSortKey(right)));
    return Buffer.concat(
        sorted.map((entry) =>
            Buffer.concat([
                Buffer.from(`${entry.mode.replace(/^0/, "")} ${entry.name}\0`),
                Buffer.from(entry.oid, "hex"),
            ])
        )
    );
}

function treeSortKey(entry: IncrementalTreeEntry): Buffer {
    return Buffer.from(entry.type === "tree" ? `${entry.name}/` : entry.name);
}

function parseTree(bytes: Buffer): Map<string, { mode: string; oid: string }> {
    const entries = new Map<string, { mode: string; oid: string }>();
    let offset = 0;
    while (offset < bytes.length) {
        const space = bytes.indexOf(0x20, offset);
        const nul = bytes.indexOf(0, space + 1);
        const mode = bytes.subarray(offset, space).toString("ascii");
        const name = bytes.subarray(space + 1, nul).toString("utf8");
        entries.set(name, { mode, oid: bytes.subarray(nul + 1, nul + 21).toString("hex") });
        offset = nul + 21;
    }
    return entries;
}
