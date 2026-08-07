// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import { WorkspaceMutationLog, type WorkspaceMutationMetadataV1 } from "./workspace-mutation-log";

const WorkspaceIdentity = "a".repeat(64);
const WorkspaceIncarnation = "b".repeat(64);
const WorkspaceHeadRef = "refs/crest/workspace-head";
const ZeroOid = "0".repeat(40);
const ExpectedMaxMetadataBytes = 60 * 1024;

interface Fixture {
    gitDir: string;
    git: WorkspaceGitRunner;
    log: WorkspaceMutationLog;
}

describe.sequential("WorkspaceMutationLog", () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    test("appends one CAS-ordered root commit with canonical owner metadata", async () => {
        const fixture = await makeFixture(roots);
        const tree = await writeTree(fixture, { "shared.txt": "owner value" });
        const metadata: WorkspaceMutationMetadataV1 = {
            workspaceincarnation: WorkspaceIncarnation,
            kind: "agent-turn",
            schemaversion: 1,
            turnid: "turn-a",
            workspaceidentity: WorkspaceIdentity,
            sessionid: "session-a",
        };

        await expect(fixture.log.readHead()).resolves.toBeUndefined();
        const commit = await fixture.log.append({ tree, metadata });

        await expect(fixture.log.readHead()).resolves.toBe(commit);
        await expect(fixture.log.read(commit)).resolves.toEqual({ tree, metadata });
        await expect(fixture.log.changedPaths(commit)).resolves.toEqual(["shared.txt"]);
        const stored = await readCommit(fixture, commit);
        expect(stored).toMatch(/^author Crest Workspace <workspace@crest\.invalid> /m);
        expect(stored).toMatch(/^committer Crest Workspace <workspace@crest\.invalid> /m);
        expect(stored.slice(stored.indexOf("\n\n") + 2)).toBe(canonicalJson(metadata));
        const count = await fixture.git.run(["rev-list", "--count", WorkspaceHeadRef], {
            gitDir: fixture.gitDir,
            timeoutMs: 5_000,
        });
        expect(count.stdout.toString("ascii").trim()).toBe("1");
    });

    test("prepares an immutable commit without publishing the workspace head", async () => {
        const fixture = await makeFixture(roots);
        const base = await fixture.log.append({
            tree: await writeTree(fixture, { "shared.txt": "base" }),
            metadata: makeMetadata("external"),
        });
        const prepared = await fixture.log.prepare({
            expectedHead: base,
            tree: await writeTree(fixture, { "shared.txt": "prepared" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });

        expect(Object.isFrozen(prepared)).toBe(true);
        await expect(fixture.log.readHead()).resolves.toBe(base);
        await expect(fixture.log.read(prepared.commit)).resolves.toMatchObject({
            parent: base,
            metadata: { kind: "agent-turn", sessionid: "session-a" },
        });

        await expect(fixture.log.publishPrepared(prepared)).resolves.toBe(prepared.commit);
        await expect(fixture.log.readHead()).resolves.toBe(prepared.commit);
    });

    test("publishes only the exact prepared mutation token", async () => {
        const fixture = await makeFixture(roots);
        const prepared = await fixture.log.prepare({
            tree: await writeTree(fixture, { "shared.txt": "prepared" }),
            metadata: makeMetadata("external"),
        });

        await expect(fixture.log.publishPrepared({ ...prepared })).rejects.toThrow(/prepared mutation token/i);
        await expect(fixture.log.readHead()).resolves.toBeUndefined();
        await expect(fixture.log.publishPrepared(prepared)).resolves.toBe(prepared.commit);
    });

    test("does not treat a nested ref as the exact workspace head", async () => {
        const fixture = await makeFixture(roots);
        const commit = await writeRawCommit(
            fixture,
            await writeTree(fixture, { "shared.txt": "nested" }),
            canonicalJson(makeMetadata("external"))
        );
        await fixture.git.run(["update-ref", `${WorkspaceHeadRef}/nested`, commit, ZeroOid], {
            gitDir: fixture.gitDir,
            timeoutMs: 5_000,
        });

        await expect(fixture.log.readHead()).resolves.toBeUndefined();
    });

    test("rejects a symbolic workspace head", async () => {
        const fixture = await makeFixture(roots);
        const commit = await fixture.log.append({
            tree: await writeTree(fixture, { "shared.txt": "authority" }),
            metadata: makeMetadata("external"),
        });
        await replaceWorkspaceHeadWithSymbolicRef(fixture, "refs/heads/authority", commit);

        await expect(fixture.log.readHead()).rejects.toThrow(/symbolic/i);
    });

    test("does not publish through a symbolic workspace head", async () => {
        const fixture = await makeFixture(roots);
        const authority = await fixture.log.append({
            tree: await writeTree(fixture, { "shared.txt": "authority" }),
            metadata: makeMetadata("external"),
        });
        const authorityRef = "refs/heads/authority";
        await replaceWorkspaceHeadWithSymbolicRef(fixture, authorityRef, authority);

        await expect(
            fixture.log.append({
                expectedHead: authority,
                tree: await writeTree(fixture, { "shared.txt": "must not publish" }),
                metadata: makeMetadata("agent-turn", "session-a"),
            })
        ).rejects.toThrow();
        await expect(readRef(fixture, authorityRef)).resolves.toBe(authority);
        await expect(readFile(join(fixture.gitDir, WorkspaceHeadRef), "utf8")).resolves.toBe(`ref: ${authorityRef}\n`);
    });

    test.each(["sessionid", "operationid"] as const)(
        "rejects canonical metadata over the writer limit via %s without mutating Git",
        async (field) => {
            const fixture = await makeFixture(roots);
            const base = await fixture.log.append({
                tree: await writeTree(fixture, { "shared.txt": "base" }),
                metadata: makeMetadata("external"),
            });
            const nextTree = await writeTree(fixture, { "shared.txt": "next" });
            const objectsBefore = await countLooseObjects(fixture);
            const metadata = makeMetadataWithCanonicalSize(field, ExpectedMaxMetadataBytes + 1);
            expect(Buffer.byteLength(canonicalJson(metadata))).toBe(ExpectedMaxMetadataBytes + 1);

            await expect(
                fixture.log.append({
                    expectedHead: base,
                    tree: nextTree,
                    metadata,
                })
            ).rejects.toThrow(/metadata.*(?:large|size|limit)/i);
            await expect(fixture.log.readHead()).resolves.toBe(base);
            await expect(countLooseObjects(fixture)).resolves.toBe(objectsBefore);
        }
    );

    test("round-trips canonical metadata at the writer limit", async () => {
        const fixture = await makeFixture(roots);
        const base = await fixture.log.append({
            tree: await writeTree(fixture, { "shared.txt": "base" }),
            metadata: makeMetadata("external"),
        });
        const tree = await writeTree(fixture, { "shared.txt": "next" });
        const metadata = makeMetadataWithCanonicalSize("operationid", ExpectedMaxMetadataBytes);
        expect(Buffer.byteLength(canonicalJson(metadata))).toBe(ExpectedMaxMetadataBytes);

        const commit = await fixture.log.append({ expectedHead: base, tree, metadata });

        await expect(fixture.log.read(commit)).resolves.toEqual({ parent: base, tree, metadata });
    });

    test("rejects append when the workspace head moved", async () => {
        const fixture = await makeFixture(roots);
        const base = await fixture.log.append({
            tree: await writeTree(fixture, { "shared.txt": "base" }),
            metadata: makeMetadata("external"),
        });
        const moved = await fixture.log.append({
            expectedHead: base,
            tree: await writeTree(fixture, { "shared.txt": "moved" }),
            metadata: makeMetadata("agent-turn", "session-b"),
        });

        await expect(
            fixture.log.append({
                expectedHead: base,
                tree: await writeTree(fixture, { "shared.txt": "stale" }),
                metadata: makeMetadata("agent-turn", "session-a"),
            })
        ).rejects.toMatchObject({ code: "nonzero_exit" });
        await expect(fixture.log.readHead()).resolves.toBe(moved);
    });

    test("finds foreign same-path ABA history even when final bytes match", async () => {
        const fixture = await makeFixture(roots);
        const ownerTree = await writeTree(fixture, { "shared.txt": "owner value" });
        const owner = await fixture.log.append({
            tree: ownerTree,
            metadata: makeMetadata("agent-turn", "session-a"),
        });
        const foreignWrite = await fixture.log.append({
            expectedHead: owner,
            tree: await writeTree(fixture, { "shared.txt": "foreign value" }),
            metadata: makeMetadata("agent-turn", "session-b"),
        });
        const foreignAba = await fixture.log.append({
            expectedHead: foreignWrite,
            tree: ownerTree,
            metadata: makeMetadata("agent-turn", "session-b"),
        });

        const overlaps = await fixture.log.findForeignOverlap({
            afterCommit: owner,
            paths: ["shared.txt"],
            includedCommits: new Set(),
            ownerSessionId: "session-a",
        });

        expect(overlaps).toHaveLength(2);
        expect(overlaps).toEqual(
            expect.arrayContaining([
                { commit: foreignWrite, path: "shared.txt", sessionId: "session-b" },
                { commit: foreignAba, path: "shared.txt", sessionId: "session-b" },
            ])
        );
    });

    test("ignores later different-path commits", async () => {
        const fixture = await makeFixture(roots);
        const owner = await fixture.log.append({
            tree: await writeTree(fixture, { "other.txt": "base", "shared.txt": "owner" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });
        await fixture.log.append({
            expectedHead: owner,
            tree: await writeTree(fixture, { "other.txt": "foreign", "shared.txt": "owner" }),
            metadata: makeMetadata("agent-turn", "session-b"),
        });

        await expect(
            fixture.log.findForeignOverlap({
                afterCommit: owner,
                paths: ["shared.txt"],
                includedCommits: new Set(),
                ownerSessionId: "session-a",
            })
        ).resolves.toEqual([]);
    });

    test("rejects an overlapping Crest mutation without a Session owner", async () => {
        const fixture = await makeFixture(roots);
        const owner = await fixture.log.append({
            tree: await writeTree(fixture, { "shared.txt": "owner" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });
        await fixture.log.append({
            expectedHead: owner,
            tree: await writeTree(fixture, { "shared.txt": "unowned" }),
            metadata: makeMetadata("turn-undo"),
        });

        await expect(
            fixture.log.findForeignOverlap({
                afterCommit: owner,
                paths: ["shared.txt"],
                includedCommits: new Set(),
                ownerSessionId: "session-a",
            })
        ).rejects.toThrow(/owner|session/i);
    });

    test("ignores only included commits authorized for the owner Session", async () => {
        const fixture = await makeFixture(roots);
        const owner = await fixture.log.append({
            tree: await writeTree(fixture, { "shared.txt": "one" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });
        const included = await fixture.log.append({
            expectedHead: owner,
            tree: await writeTree(fixture, { "shared.txt": "two" }),
            metadata: makeMetadata("turn-undo", "session-a"),
        });
        const laterSameSession = await fixture.log.append({
            expectedHead: included,
            tree: await writeTree(fixture, { "shared.txt": "three" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });

        await expect(
            fixture.log.findForeignOverlap({
                afterCommit: owner,
                paths: ["shared.txt"],
                includedCommits: new Set([included]),
                ownerSessionId: "session-a",
            })
        ).resolves.toEqual([{ commit: laterSameSession, path: "shared.txt", sessionId: "session-a" }]);
    });

    test("rejects an included commit owned by another Session", async () => {
        const fixture = await makeFixture(roots);
        const owner = await fixture.log.append({
            tree: await writeTree(fixture, { "shared.txt": "one" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });
        const foreign = await fixture.log.append({
            expectedHead: owner,
            tree: await writeTree(fixture, { "shared.txt": "two" }),
            metadata: makeMetadata("agent-turn", "session-b"),
        });

        await expect(
            fixture.log.findForeignOverlap({
                afterCommit: owner,
                paths: ["shared.txt"],
                includedCommits: new Set([foreign]),
                ownerSessionId: "session-a",
            })
        ).rejects.toThrow(/included commit|owner Session/i);
    });

    test("rejects an included external commit even when it claims the owner Session", async () => {
        const fixture = await makeFixture(roots);
        const owner = await fixture.log.append({
            tree: await writeTree(fixture, { "shared.txt": "one" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });
        const external = await fixture.log.append({
            expectedHead: owner,
            tree: await writeTree(fixture, { "shared.txt": "external" }),
            metadata: makeMetadata("external", "session-a"),
        });

        await expect(
            fixture.log.findForeignOverlap({
                afterCommit: owner,
                paths: ["shared.txt"],
                includedCommits: new Set([external]),
                ownerSessionId: "session-a",
            })
        ).rejects.toThrow(/included commit|owner Session/i);
    });

    test.each([
        ["at the boundary", "boundary"],
        ["before the boundary", "before"],
    ] as const)("rejects an included commit %s", async (_label, includedPosition) => {
        const fixture = await makeFixture(roots);
        const beforeBoundary = await fixture.log.append({
            tree: await writeTree(fixture, { "shared.txt": "before" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });
        const boundary = await fixture.log.append({
            expectedHead: beforeBoundary,
            tree: await writeTree(fixture, { "shared.txt": "boundary" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });
        await fixture.log.append({
            expectedHead: boundary,
            tree: await writeTree(fixture, { "shared.txt": "boundary" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });

        await expect(
            fixture.log.findForeignOverlap({
                afterCommit: boundary,
                paths: ["shared.txt"],
                includedCommits: new Set([includedPosition === "boundary" ? boundary : beforeBoundary]),
                ownerSessionId: "session-a",
            })
        ).rejects.toThrow(/included commit|suffix/i);
    });

    test.each([
        ["foreign", makeMetadata("agent-turn", "session-b")],
        ["external", makeMetadata("external")],
    ] as const)("rejects an included %s side-branch commit", async (_label, metadata) => {
        const fixture = await makeFixture(roots);
        const boundary = await fixture.log.append({
            tree: await writeTree(fixture, { "shared.txt": "boundary" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });
        await fixture.log.append({
            expectedHead: boundary,
            tree: await writeTree(fixture, { "shared.txt": "head" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });
        const sideBranch = await writeRawCommit(
            fixture,
            await writeTree(fixture, { "shared.txt": "side branch" }),
            canonicalJson(metadata),
            boundary
        );

        await expect(
            fixture.log.findForeignOverlap({
                afterCommit: boundary,
                paths: ["other.txt"],
                includedCommits: new Set([sideBranch]),
                ownerSessionId: "session-a",
            })
        ).rejects.toThrow(/included commit|suffix/i);
    });

    test("rejects an included unknown object", async () => {
        const fixture = await makeFixture(roots);
        const boundary = await fixture.log.append({
            tree: await writeTree(fixture, { "shared.txt": "boundary" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });
        await fixture.log.append({
            expectedHead: boundary,
            tree: await writeTree(fixture, { "shared.txt": "head" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });

        await expect(
            fixture.log.findForeignOverlap({
                afterCommit: boundary,
                paths: ["other.txt"],
                includedCommits: new Set(["f".repeat(40)]),
                ownerSessionId: "session-a",
            })
        ).rejects.toThrow(/included commit|suffix/i);
    });

    test("reports external overlap without a Session owner", async () => {
        const fixture = await makeFixture(roots);
        const owner = await fixture.log.append({
            tree: await writeTree(fixture, { "shared.txt": "one" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });
        const external = await fixture.log.append({
            expectedHead: owner,
            tree: await writeTree(fixture, { "shared.txt": "external" }),
            metadata: makeMetadata("external"),
        });

        await expect(
            fixture.log.findForeignOverlap({
                afterCommit: owner,
                paths: ["shared.txt"],
                includedCommits: new Set(),
                ownerSessionId: "session-a",
            })
        ).resolves.toEqual([{ commit: external, path: "shared.txt" }]);
    });

    test.each([
        ["extra metadata key", canonicalJson({ ...makeMetadata("agent-turn", "session-b"), unexpected: true })],
        ["noncanonical metadata JSON", JSON.stringify(makeMetadata("agent-turn", "session-b"))],
        [
            "foreign workspace metadata",
            canonicalJson({ ...makeMetadata("agent-turn", "session-b"), workspaceidentity: "c".repeat(64) }),
        ],
    ])("rejects %s", async (_label, message) => {
        const fixture = await makeFixture(roots);
        const owner = await fixture.log.append({
            tree: await writeTree(fixture, { "shared.txt": "owner" }),
            metadata: makeMetadata("agent-turn", "session-a"),
        });
        const malformed = await writeRawCommit(
            fixture,
            await writeTree(fixture, { "shared.txt": "malformed" }),
            message,
            owner
        );
        await publish(fixture, malformed, owner);

        await expect(fixture.log.read(malformed)).rejects.toThrow(/metadata|workspace|canonical/i);
        await expect(
            fixture.log.findForeignOverlap({
                afterCommit: owner,
                paths: ["shared.txt"],
                includedCommits: new Set(),
                ownerSessionId: "session-a",
            })
        ).rejects.toThrow(/metadata|workspace|canonical/i);
    });

    test("rejects a commit whose tree OID names a blob", async () => {
        const fixture = await makeFixture(roots);
        const blob = await writeBlob(fixture, "not a tree");
        const malformed = await writeRawCommitObject(fixture, blob, canonicalJson(makeMetadata("external")));

        await expect(fixture.log.read(malformed)).rejects.toThrow(/tree object/i);
    });

    test("rejects a commit whose parent OID names a tree", async () => {
        const fixture = await makeFixture(roots);
        const tree = await writeTree(fixture, { "shared.txt": "value" });
        const malformed = await writeRawCommitObject(fixture, tree, canonicalJson(makeMetadata("external")), tree);

        await expect(fixture.log.read(malformed)).rejects.toThrow(/parent object/i);
    });

    test("rejects non-SHA-1 object ids and noncanonical input paths", async () => {
        const fixture = await makeFixture(roots);
        const tree = await writeTree(fixture, { "shared.txt": "owner" });

        await expect(fixture.log.append({ tree: "f".repeat(64), metadata: makeMetadata("external") })).rejects.toThrow(
            /SHA-1/i
        );
        await expect(fixture.log.read("f".repeat(64))).rejects.toThrow(/SHA-1/i);
        await expect(fixture.log.changedPaths("not-an-object")).rejects.toThrow(/SHA-1/i);
        await expect(
            fixture.log.findForeignOverlap({
                afterCommit: tree,
                paths: ["../shared.txt"],
                includedCommits: new Set(),
                ownerSessionId: "session-a",
            })
        ).rejects.toThrow(/workspace-relative path/i);
    });

    test("rejects noncanonical paths decoded from a commit", async () => {
        const fixture = await makeFixture(roots);
        const commit = await writeRawCommit(
            fixture,
            await writeTree(fixture, { "back\\slash.txt": "invalid" }),
            canonicalJson(makeMetadata("external"))
        );

        await expect(fixture.log.changedPaths(commit)).rejects.toThrow(/workspace-relative path/i);
    });
});

async function makeFixture(roots: string[]): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "crest-workspace-mutation-log-"));
    roots.push(root);
    const gitDir = join(root, "repo.git");
    const git = new WorkspaceGitRunner();
    await git.run(["init", "--bare", gitDir], { cwd: root, timeoutMs: 5_000 });
    return {
        gitDir,
        git,
        log: new WorkspaceMutationLog({
            git,
            gitDir,
            workspaceIdentity: WorkspaceIdentity,
            workspaceIncarnation: WorkspaceIncarnation,
        }),
    };
}

function makeMetadata(kind: WorkspaceMutationMetadataV1["kind"], sessionid?: string): WorkspaceMutationMetadataV1 {
    return {
        schemaversion: 1,
        workspaceidentity: WorkspaceIdentity,
        workspaceincarnation: WorkspaceIncarnation,
        kind,
        ...(sessionid == null ? {} : { sessionid }),
    };
}

function makeMetadataWithCanonicalSize(field: "sessionid" | "operationid", size: number): WorkspaceMutationMetadataV1 {
    const metadata = { ...makeMetadata("agent-turn", "session-a"), [field]: "" };
    const valueBytes = size - Buffer.byteLength(canonicalJson(metadata));
    if (valueBytes < 1) throw new Error("Requested metadata size is too small");
    metadata[field] = "x".repeat(valueBytes);
    return metadata;
}

async function replaceWorkspaceHeadWithSymbolicRef(
    fixture: Fixture,
    authorityRef: string,
    authority: string
): Promise<void> {
    await fixture.git.run(["update-ref", authorityRef, authority, ZeroOid], {
        gitDir: fixture.gitDir,
        timeoutMs: 5_000,
    });
    await writeFile(join(fixture.gitDir, WorkspaceHeadRef), `ref: ${authorityRef}\n`);
}

async function readRef(fixture: Fixture, ref: string): Promise<string> {
    const result = await fixture.git.run(["rev-parse", "--verify", ref], {
        gitDir: fixture.gitDir,
        timeoutMs: 5_000,
    });
    return result.stdout.toString("ascii").trim();
}

async function countLooseObjects(fixture: Fixture): Promise<number> {
    const result = await fixture.git.run(["count-objects", "-v"], {
        gitDir: fixture.gitDir,
        timeoutMs: 5_000,
    });
    const count = /^count: (\d+)$/m.exec(result.stdout.toString("ascii"))?.[1];
    if (count == null) throw new Error("Missing loose object count");
    return Number(count);
}

async function writeTree(fixture: Fixture, entries: Readonly<Record<string, string>>): Promise<string> {
    const treeEntries: Array<{ path: string; oid: string }> = [];
    for (const [path, contents] of Object.entries(entries)) {
        const result = await fixture.git.run(["hash-object", "-w", "--stdin"], {
            gitDir: fixture.gitDir,
            stdin: Buffer.from(contents),
            timeoutMs: 5_000,
        });
        treeEntries.push({ path, oid: result.stdout.toString("ascii").trim() });
    }
    treeEntries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
    const input = Buffer.concat(
        treeEntries.map(({ path, oid }) => Buffer.concat([Buffer.from(`100644 blob ${oid}\t${path}`), Buffer.of(0)]))
    );
    const result = await fixture.git.run(["mktree", "-z"], {
        gitDir: fixture.gitDir,
        stdin: input,
        timeoutMs: 5_000,
    });
    return result.stdout.toString("ascii").trim();
}

async function writeBlob(fixture: Fixture, contents: string): Promise<string> {
    const result = await fixture.git.run(["hash-object", "-w", "--stdin"], {
        gitDir: fixture.gitDir,
        stdin: Buffer.from(contents),
        timeoutMs: 5_000,
    });
    return result.stdout.toString("ascii").trim();
}

async function writeRawCommit(fixture: Fixture, tree: string, message: string, parent?: string): Promise<string> {
    const result = await fixture.git.run(["commit-tree", tree, ...(parent == null ? [] : ["-p", parent])], {
        gitDir: fixture.gitDir,
        stdin: Buffer.from(message),
        timeoutMs: 5_000,
    });
    return result.stdout.toString("ascii").trim();
}

async function writeRawCommitObject(fixture: Fixture, tree: string, message: string, parent?: string): Promise<string> {
    const timestamp = "1700000000 +0000";
    const contents = [
        `tree ${tree}`,
        ...(parent == null ? [] : [`parent ${parent}`]),
        `author Test Author <author@example.test> ${timestamp}`,
        `committer Test Committer <committer@example.test> ${timestamp}`,
        "",
        message,
    ].join("\n");
    const result = await fixture.git.run(["hash-object", "-t", "commit", "-w", "--stdin"], {
        gitDir: fixture.gitDir,
        stdin: Buffer.from(contents),
        timeoutMs: 5_000,
    });
    return result.stdout.toString("ascii").trim();
}

async function publish(fixture: Fixture, commit: string, expected?: string): Promise<void> {
    await fixture.git.run(["update-ref", WorkspaceHeadRef, commit, expected ?? ZeroOid], {
        gitDir: fixture.gitDir,
        timeoutMs: 5_000,
    });
}

async function readCommit(fixture: Fixture, commit: string): Promise<string> {
    const result = await fixture.git.run(["cat-file", "-p", commit], {
        gitDir: fixture.gitDir,
        timeoutMs: 5_000,
    });
    return result.stdout.toString("utf8");
}

function canonicalJson(value: unknown): string {
    return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJsonValue);
    if (typeof value !== "object" || value == null) return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, item]) => [key, sortJsonValue(item)])
    );
}
