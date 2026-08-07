// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { WorkspaceGitRunner } from "./git-runner";
import { ShadowWorkspaceIndex } from "./shadow-workspace-index";
import type { CapturedPathStateV1 } from "./types";

interface Fixture {
    root: string;
    gitDir: string;
    indexFile: string;
    git: RecordingGitRunner;
    index: ShadowWorkspaceIndex;
}

describe.sequential("ShadowWorkspaceIndex", () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    test("writes exact regular, executable, symlink, binary, and whitespace-path states", async () => {
        const fixture = await makeFixture(roots);
        const states = [
            await rawState(fixture, "regular.txt", Buffer.from("regular\r\nbytes\n")),
            await rawState(fixture, "bin/run", Buffer.from("#!/bin/sh\nexit 0\n"), true),
            await rawSymlink(fixture, "link", Buffer.from("target/with spaces")),
            await rawState(fixture, "binary.dat", Buffer.from([0, 1, 2, 255, 0, 13, 10])),
            await rawState(fixture, "space name.txt", Buffer.from("space")),
            await rawState(fixture, "line\nname.txt", Buffer.from("newline")),
        ];

        await fixture.index.load();
        await fixture.index.apply(states);
        const tree = await fixture.index.writeTree();
        const entries = await readTree(fixture, tree);

        expect([...entries].map(([path, value]) => [path, value.mode])).toEqual([
            ["bin/run", "100755"],
            ["binary.dat", "100644"],
            ["line\nname.txt", "100644"],
            ["link", "120000"],
            ["regular.txt", "100644"],
            ["space name.txt", "100644"],
        ]);
        for (const input of states) {
            if (input.state.state !== "file" && input.state.state !== "symlink") continue;
            expect(
                (await readBlob(fixture, entries.get(input.path)!.oid)).equals(await readBlob(fixture, input.state.oid))
            ).toBe(true);
        }
    });

    test("creates and removes exact paths without retaining deleted entries", async () => {
        const fixture = await makeFixture(roots);
        await fixture.index.load();
        await fixture.index.apply([
            await rawState(fixture, "keep.txt", Buffer.from("keep")),
            await rawState(fixture, "remove.txt", Buffer.from("remove")),
            await rawState(fixture, "excluded.txt", Buffer.from("excluded")),
        ]);

        await fixture.index.apply([
            { path: "remove.txt", state: { state: "absent" } },
            { path: "excluded.txt", state: { state: "excluded", reason: "ignored" } },
        ]);

        expect([...(await readTree(fixture, await fixture.index.writeTree())).keys()]).toEqual(["keep.txt"]);
    });

    test("treats mutation candidates as literal paths", async () => {
        const fixture = await makeFixture(roots);
        await fixture.index.load();
        await fixture.index.apply([
            await rawState(fixture, "literal[1].txt", Buffer.from("brackets")),
            await rawState(fixture, "literal1.txt", Buffer.from("plain")),
        ]);

        await fixture.index.apply([{ path: "literal[1].txt", state: { state: "absent" } }]);

        expect([...(await readTree(fixture, await fixture.index.writeTree())).keys()]).toEqual(["literal1.txt"]);
    });

    test("resolves directory-to-file and file-to-directory conflicts from candidate paths", async () => {
        const fixture = await makeFixture(roots);
        await fixture.index.load();
        await fixture.index.apply([
            await rawState(fixture, "dir/child.txt", Buffer.from("child")),
            await rawState(fixture, "other.txt", Buffer.from("other")),
        ]);
        const baseTree = await fixture.index.writeTree();
        const next = new ShadowWorkspaceIndex({
            git: fixture.git,
            gitDir: fixture.gitDir,
            indexFile: join(fixture.root, "next-index"),
        });
        await next.load(baseTree);

        fixture.git.updateIndexInputs.length = 0;
        await next.apply([await rawState(fixture, "dir", Buffer.from("file"))]);
        expect(fixture.git.updateIndexInputs).toHaveLength(1);
        expect([...(await readTree(fixture, await next.writeTree())).keys()]).toEqual(["dir", "other.txt"]);

        fixture.git.updateIndexInputs.length = 0;
        await next.apply([await rawState(fixture, "dir/recreated.txt", Buffer.from("recreated"))]);
        expect(fixture.git.updateIndexInputs).toHaveLength(1);
        expect([...(await readTree(fixture, await next.writeTree())).keys()]).toEqual([
            "dir/recreated.txt",
            "other.txt",
        ]);
    });

    test("queries only deep mutation candidates without enumerating sibling subtrees", async () => {
        const fixture = await makeFixture(roots);
        await fixture.index.load();
        await fixture.index.apply([await rawState(fixture, "parent/sibling/keep.txt", Buffer.from("sibling"))]);
        fixture.git.calls.length = 0;
        fixture.git.updateIndexInputs.length = 0;

        const candidate = await rawState(fixture, "parent/child/file.txt", Buffer.from("candidate"));
        await fixture.index.apply([candidate]);

        expect(fixture.git.calls.filter((args) => args[0] === "ls-files")).toEqual([
            ["ls-files", "--stage", "-z", "--", "parent/child/file.txt"],
        ]);
        expect(fixture.git.updateIndexInputs).toEqual([
            Buffer.concat([
                indexInfoRecord("0", "0".repeat(40), "parent"),
                indexInfoRecord("0", "0".repeat(40), "parent/child"),
                indexInfoRecord("100644", candidate.state.state === "file" ? candidate.state.oid : "", candidate.path),
            ]),
        ]);
        expect([...(await readTree(fixture, await fixture.index.writeTree())).keys()]).toEqual([
            "parent/child/file.txt",
            "parent/sibling/keep.txt",
        ]);
    });

    test("does not execute repository clean filters or index hooks", async () => {
        const fixture = await makeFixture(roots);
        const filterMarker = join(fixture.root, "filter-ran");
        const hookMarker = join(fixture.root, "hook-ran");
        const filterScript = join(fixture.root, "filter.mjs");
        const hook = join(fixture.gitDir, "hooks", "post-index-change");
        await writeFile(
            filterScript,
            `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(filterMarker)}, "ran");\nprocess.stdout.write("filtered");\n`
        );
        await writeFile(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(hookMarker)}\n`);
        await chmod(hook, 0o755);
        await fixture.git.run(["config", "filter.mutate.clean", `node ${filterScript}`], {
            gitDir: fixture.gitDir,
            timeoutMs: 5_000,
        });
        const raw = Buffer.from("raw bytes\r\n\0unchanged");
        const filtered = await rawState(fixture, "filtered.txt", raw);

        await fixture.index.load();
        await fixture.index.apply([
            await rawState(fixture, ".gitattributes", Buffer.from("*.txt filter=mutate\n")),
            filtered,
        ]);
        const entries = await readTree(fixture, await fixture.index.writeTree());

        expect(await readBlob(fixture, entries.get("filtered.txt")!.oid)).toEqual(raw);
        await expect(readFile(filterMarker)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("rejects duplicate, noncanonical, and simultaneous D/F mutation inputs", async () => {
        const fixture = await makeFixture(roots);
        const state = (await rawState(fixture, "valid.txt", Buffer.from("valid"))).state;
        await fixture.index.load();

        await expect(
            fixture.index.apply([
                { path: "same.txt", state },
                { path: "same.txt", state: { state: "absent" } },
            ])
        ).rejects.toThrow(/duplicate/i);
        await expect(fixture.index.apply([{ path: "../outside", state }])).rejects.toThrow(/workspace-relative/i);
        await expect(
            fixture.index.apply([
                { path: "conflict", state },
                { path: "conflict/child", state },
            ])
        ).rejects.toThrow(/conflict/i);
    });

    test("rejects malformed and non-blob state object ids", async () => {
        const fixture = await makeFixture(roots);
        await fixture.index.load();
        const emptyTree = await fixture.index.writeTree();

        await expect(
            fixture.index.apply([{ path: "bad.txt", state: { state: "file", oid: "not-an-oid", executable: false } }])
        ).rejects.toThrow(/object id/i);
        await expect(
            fixture.index.apply([{ path: "tree.txt", state: { state: "file", oid: emptyTree, executable: false } }])
        ).rejects.toThrow(/blob/i);
    });

    test("fails closed for invalid construction, load trees, and unloaded writes", async () => {
        const fixture = await makeFixture(roots);
        expect(
            () =>
                new ShadowWorkspaceIndex({
                    git: fixture.git,
                    gitDir: "relative.git",
                    indexFile: fixture.indexFile,
                })
        ).toThrow(/absolute/i);
        await expect(fixture.index.load("not-an-oid")).rejects.toThrow(/object id/i);
        const blob = await writeRawBlob(fixture, Buffer.from("not a tree"));
        await expect(fixture.index.load(blob)).rejects.toThrow(/tree/i);
        const unloaded = new ShadowWorkspaceIndex({
            git: fixture.git,
            gitDir: fixture.gitDir,
            indexFile: join(fixture.root, "unloaded-index"),
        });
        await expect(unloaded.writeTree()).rejects.toThrow(/load/i);
    });

    test("fails closed after an update-index failure until authority is reloaded", async () => {
        const fixture = await makeFixture(roots);
        await fixture.index.load();
        const baseTree = await fixture.index.writeTree();
        const candidate = await rawState(fixture, "candidate.txt", Buffer.from("candidate"));

        fixture.git.failNextCommand = "update-index";
        await expect(fixture.index.apply([candidate])).rejects.toThrow(/injected update-index/i);
        expect(fixture.index.loaded).toBe(false);
        await expect(fixture.index.writeTree()).rejects.toThrow(/load/i);
        await expect(fixture.index.apply([candidate])).rejects.toThrow(/load/i);

        await fixture.index.load(baseTree);
        await fixture.index.apply([candidate]);
        expect([...(await readTree(fixture, await fixture.index.writeTree())).keys()]).toEqual(["candidate.txt"]);
    });

    test("fails closed after read-tree or write-tree failures until authority is reloaded", async () => {
        const fixture = await makeFixture(roots);
        await fixture.index.load();
        const baseTree = await fixture.index.writeTree();

        fixture.git.failNextCommand = "read-tree";
        await expect(fixture.index.load(baseTree)).rejects.toThrow(/injected read-tree/i);
        expect(fixture.index.loaded).toBe(false);
        await expect(fixture.index.writeTree()).rejects.toThrow(/load/i);

        await fixture.index.load(baseTree);
        fixture.git.failNextCommand = "write-tree";
        await expect(fixture.index.writeTree()).rejects.toThrow(/injected write-tree/i);
        expect(fixture.index.loaded).toBe(false);
        await expect(fixture.index.apply([])).rejects.toThrow(/load/i);

        await fixture.index.load(baseTree);
        await expect(fixture.index.writeTree()).resolves.toBe(baseTree);
    });
});

async function makeFixture(roots: string[]): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "crest-shadow-workspace-index-"));
    roots.push(root);
    const gitDir = join(root, "repo.git");
    const indexFile = join(root, "private-index");
    const git = new RecordingGitRunner();
    await git.run(["init", "--bare", gitDir], { cwd: root, timeoutMs: 5_000 });
    return {
        root,
        gitDir,
        indexFile,
        git,
        index: new ShadowWorkspaceIndex({ git, gitDir, indexFile }),
    };
}

async function rawState(
    fixture: Fixture,
    path: string,
    bytes: Buffer,
    executable = false
): Promise<{ path: string; state: CapturedPathStateV1 }> {
    return { path, state: { state: "file", oid: await writeRawBlob(fixture, bytes), executable } };
}

async function rawSymlink(
    fixture: Fixture,
    path: string,
    target: Buffer
): Promise<{ path: string; state: CapturedPathStateV1 }> {
    return { path, state: { state: "symlink", oid: await writeRawBlob(fixture, target) } };
}

async function writeRawBlob(fixture: Fixture, bytes: Buffer): Promise<string> {
    const result = await fixture.git.run(["hash-object", "-w", "--stdin", "--no-filters"], {
        gitDir: fixture.gitDir,
        stdin: bytes,
        timeoutMs: 5_000,
    });
    return result.stdout.toString("ascii").trim();
}

async function readBlob(fixture: Fixture, oid: string): Promise<Buffer> {
    return (
        await fixture.git.run(["cat-file", "blob", oid], {
            gitDir: fixture.gitDir,
            timeoutMs: 5_000,
        })
    ).stdout;
}

async function readTree(fixture: Fixture, tree: string): Promise<Map<string, { mode: string; oid: string }>> {
    const result = await fixture.git.run(["ls-tree", "-r", "-z", "--full-tree", tree], {
        gitDir: fixture.gitDir,
        timeoutMs: 5_000,
    });
    const entries = new Map<string, { mode: string; oid: string }>();
    if (result.stdout.length === 0) return entries;
    for (const record of result.stdout.subarray(0, -1).toString("utf8").split("\0")) {
        const match = /^(\d+) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(record);
        if (!match) throw new Error(`Invalid ls-tree record: ${record}`);
        entries.set(match[3]!, { mode: match[1]!, oid: match[2]! });
    }
    return entries;
}

class RecordingGitRunner extends WorkspaceGitRunner {
    readonly calls: string[][] = [];
    readonly updateIndexInputs: Buffer[] = [];
    failNextCommand = "";

    override async run(...input: Parameters<WorkspaceGitRunner["run"]>) {
        this.calls.push([...input[0]]);
        if (input[0][0] === "update-index" && Buffer.isBuffer(input[1]?.stdin)) {
            this.updateIndexInputs.push(Buffer.from(input[1].stdin));
        }
        if (this.failNextCommand === input[0][0]) {
            const command = this.failNextCommand;
            this.failNextCommand = "";
            throw new Error(`Injected ${command} failure`);
        }
        return await super.run(...input);
    }
}

function indexInfoRecord(mode: string, oid: string, path: string): Buffer {
    return Buffer.concat([Buffer.from(`${mode} ${oid}\t${path}`), Buffer.of(0)]);
}
