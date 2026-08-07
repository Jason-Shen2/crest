// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute } from "node:path";

import { WorkspaceGitRunner } from "./git-runner";
import { validateWorkspaceRelativePath } from "./stored-manifest";
import type { CapturedPathStateV1 } from "./types";

const GitTimeoutMs = 30_000;
const ZeroOid = "0".repeat(40);
const CoverageReasons = new Set([
    "ignored",
    "nested-repository",
    "oversized-untracked",
    "non-utf8-path",
    "hard-linked",
    "special-entry",
    "capture-budget",
]);

interface IndexEntry {
    path: string;
    mode: "100644" | "100755" | "120000";
    oid: string;
}

interface ValidatedMutation {
    path: string;
    state: CapturedPathStateV1;
    addition?: IndexEntry;
}

export class ShadowWorkspaceIndex {
    readonly git: WorkspaceGitRunner;
    readonly gitDir: string;
    readonly indexFile: string;
    loaded = false;

    constructor(input: { git: WorkspaceGitRunner; gitDir: string; indexFile: string }) {
        if (
            !(input?.git instanceof WorkspaceGitRunner) ||
            typeof input.gitDir !== "string" ||
            !isAbsolute(input.gitDir) ||
            typeof input.indexFile !== "string" ||
            !isAbsolute(input.indexFile)
        ) {
            throw new Error("Shadow Workspace index paths must be absolute");
        }
        this.git = input.git;
        this.gitDir = input.gitDir;
        this.indexFile = input.indexFile;
    }

    async load(tree?: string): Promise<void> {
        if (tree != null) {
            validateOid(tree);
            const type = await this.git.run(["cat-file", "-t", tree], {
                gitDir: this.gitDir,
                timeoutMs: GitTimeoutMs,
                maxStdoutBytes: 16,
            });
            if (!type.stdout.equals(Buffer.from("tree\n"))) {
                throw new Error("Shadow Workspace index base must be a tree");
            }
        }
        await this.git.run(["read-tree", tree ?? "--empty"], {
            gitDir: this.gitDir,
            indexFile: this.indexFile,
            timeoutMs: GitTimeoutMs,
            maxStdoutBytes: 0,
        });
        this.loaded = true;
    }

    async apply(states: ReadonlyArray<{ path: string; state: CapturedPathStateV1 }>): Promise<void> {
        this.requireLoaded();
        if (!Array.isArray(states)) throw new Error("Invalid Shadow Workspace index mutations");
        const mutations = validateMutations(states);
        if (mutations.length === 0) return;
        await this.requireBlobObjects(
            mutations.flatMap((mutation) => (mutation.addition ? [mutation.addition.oid] : []))
        );
        const existing = await this.readCandidateEntries(mutations.map((mutation) => mutation.path));
        const removals = collectRemovals(existing, mutations);
        if (removals.length > 0) {
            await this.updateIndex(removals.map((path) => ({ path, mode: "0", oid: ZeroOid })));
        }
        const additions = mutations
            .flatMap((mutation) => (mutation.addition ? [mutation.addition] : []))
            .sort((left, right) => comparePathBytes(left.path, right.path));
        if (additions.length > 0) {
            await this.updateIndex(additions);
        }
    }

    async writeTree(): Promise<string> {
        this.requireLoaded();
        const result = await this.git.run(["write-tree"], {
            gitDir: this.gitDir,
            indexFile: this.indexFile,
            timeoutMs: GitTimeoutMs,
            maxStdoutBytes: 128,
        });
        const match = /^([0-9a-f]{40})\n$/.exec(result.stdout.toString("ascii"));
        if (!match) throw new Error("Git returned an invalid Shadow Workspace tree id");
        return match[1]!;
    }

    requireLoaded(): void {
        if (!this.loaded) throw new Error("Shadow Workspace index must be loaded first");
    }

    async requireBlobObjects(oids: string[]): Promise<void> {
        const unique = [...new Set(oids)];
        if (unique.length === 0) return;
        const result = await this.git.run(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
            gitDir: this.gitDir,
            stdin: Buffer.from(`${unique.join("\n")}\n`),
            timeoutMs: GitTimeoutMs,
        });
        const lines = result.stdout.toString("ascii").trimEnd().split("\n");
        if (lines.length !== unique.length || lines.some((line, index) => line !== `${unique[index]} blob`)) {
            throw new Error("Shadow Workspace index state object must be a blob");
        }
    }

    async readCandidateEntries(paths: string[]): Promise<IndexEntry[]> {
        const pathspecs = collectPathspecs(paths);
        const result = await this.git.run(["ls-files", "--stage", "-z", "--", ...pathspecs], {
            gitDir: this.gitDir,
            indexFile: this.indexFile,
            timeoutMs: GitTimeoutMs,
        });
        return parseIndexEntries(result.stdout);
    }

    async updateIndex(entries: Array<{ path: string; mode: string; oid: string }>): Promise<void> {
        const input = Buffer.concat(
            entries.map((entry) =>
                Buffer.concat([Buffer.from(`${entry.mode} ${entry.oid}\t${entry.path}`), Buffer.of(0)])
            )
        );
        await this.git.run(["update-index", "-z", "--index-info"], {
            gitDir: this.gitDir,
            indexFile: this.indexFile,
            stdin: input,
            timeoutMs: GitTimeoutMs,
            maxStdoutBytes: 0,
        });
    }
}

function validateMutations(states: ReadonlyArray<{ path: string; state: CapturedPathStateV1 }>): ValidatedMutation[] {
    const seen = new Set<string>();
    const additions = new Set<string>();
    const mutations = states.map((input) => {
        if (!input || typeof input !== "object") throw new Error("Invalid Shadow Workspace index mutation");
        validateWorkspaceRelativePath(input.path);
        if (seen.has(input.path)) throw new Error(`Duplicate Shadow Workspace index path: ${input.path}`);
        seen.add(input.path);
        const state = validateState(input.state);
        const addition = toIndexEntry(input.path, state);
        if (addition) additions.add(input.path);
        return { path: input.path, state, ...(addition ? { addition } : {}) };
    });
    for (const path of additions) {
        let parent = path;
        while (parent.includes("/")) {
            parent = parent.slice(0, parent.lastIndexOf("/"));
            if (additions.has(parent)) {
                throw new Error(`Conflicting Shadow Workspace index additions: ${parent} and ${path}`);
            }
        }
    }
    return mutations;
}

function validateState(state: CapturedPathStateV1): CapturedPathStateV1 {
    if (!state || typeof state !== "object") throw new Error("Invalid captured path state");
    const keys = Object.keys(state);
    if (state.state === "absent") {
        if (keys.length !== 1) throw new Error("Invalid absent captured path state");
        return { state: "absent" };
    }
    if (state.state === "file") {
        if (
            keys.length !== 3 ||
            !keys.includes("oid") ||
            !keys.includes("executable") ||
            typeof state.executable !== "boolean"
        ) {
            throw new Error("Invalid file captured path state");
        }
        validateOid(state.oid);
        return { state: "file", oid: state.oid, executable: state.executable };
    }
    if (state.state === "symlink") {
        if (keys.length !== 2 || !keys.includes("oid")) throw new Error("Invalid symlink captured path state");
        validateOid(state.oid);
        return { state: "symlink", oid: state.oid };
    }
    if (
        state.state !== "excluded" ||
        keys.length !== 2 ||
        !keys.includes("reason") ||
        typeof state.reason !== "string" ||
        !CoverageReasons.has(state.reason)
    ) {
        throw new Error("Invalid excluded captured path state");
    }
    return { state: "excluded", reason: state.reason };
}

function toIndexEntry(path: string, state: CapturedPathStateV1): IndexEntry | undefined {
    if (state.state === "file") {
        return { path, mode: state.executable ? "100755" : "100644", oid: state.oid };
    }
    if (state.state === "symlink") return { path, mode: "120000", oid: state.oid };
    return undefined;
}

function collectPathspecs(paths: string[]): string[] {
    const pathspecs = new Set<string>();
    for (const path of paths) {
        const segments = path.split("/");
        for (let index = 1; index <= segments.length; index++) {
            pathspecs.add(segments.slice(0, index).join("/"));
        }
    }
    return [...pathspecs].sort(comparePathBytes);
}

function parseIndexEntries(value: Buffer): IndexEntry[] {
    if (value.length === 0) return [];
    if (value.at(-1) !== 0) throw new Error("Invalid private index output");
    const entries: IndexEntry[] = [];
    const seen = new Set<string>();
    let start = 0;
    for (let index = 0; index < value.length; index++) {
        if (value[index] !== 0) continue;
        const record = value.subarray(start, index);
        const tab = record.indexOf(0x09);
        if (tab < 0) throw new Error("Invalid private index entry");
        const header = /^(100644|100755|120000) ([0-9a-f]{40}) 0$/.exec(record.subarray(0, tab).toString("ascii"));
        if (!header) throw new Error("Invalid private index entry");
        const pathBytes = record.subarray(tab + 1);
        const path = pathBytes.toString("utf8");
        if (!Buffer.from(path).equals(pathBytes)) throw new Error("Invalid UTF-8 private index path");
        validateWorkspaceRelativePath(path);
        if (seen.has(path)) throw new Error("Duplicate private index path");
        seen.add(path);
        entries.push({ path, mode: header[1] as IndexEntry["mode"], oid: header[2]! });
        start = index + 1;
    }
    return entries.sort((left, right) => comparePathBytes(left.path, right.path));
}

function collectRemovals(existing: IndexEntry[], mutations: ValidatedMutation[]): string[] {
    const removals = new Set<string>();
    for (const mutation of mutations) {
        const prefix = `${mutation.path}/`;
        for (const entry of existing) {
            if (entry.path === mutation.path || entry.path.startsWith(prefix)) {
                removals.add(entry.path);
                continue;
            }
            if (mutation.addition && mutation.path.startsWith(`${entry.path}/`)) {
                removals.add(entry.path);
            }
        }
    }
    return [...removals].sort(comparePathBytes);
}

function validateOid(value: string): void {
    if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
        throw new Error("Invalid Git object id");
    }
}

function comparePathBytes(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
