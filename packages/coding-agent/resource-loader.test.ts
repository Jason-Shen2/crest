// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjectContextFiles } from "./resource-loader";

describe("loadProjectContextFiles", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "crest-ctx-"));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it("returns [] when no context file exists", () => {
        const cwd = join(root, "a", "b");
        mkdirSync(cwd, { recursive: true });
        expect(loadProjectContextFiles({ cwd })).toEqual([]);
    });

    it("loads AGENTS.md from cwd", () => {
        const cwd = join(root, "proj");
        mkdirSync(cwd, { recursive: true });
        writeFileSync(join(cwd, "AGENTS.md"), "Run lints.");
        const files = loadProjectContextFiles({ cwd });
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe(join(cwd, "AGENTS.md"));
        expect(files[0].content).toBe("Run lints.");
    });

    it("prefers AGENTS.md over CLAUDE.md in the same dir", () => {
        const cwd = join(root, "proj");
        mkdirSync(cwd, { recursive: true });
        writeFileSync(join(cwd, "AGENTS.md"), "agents");
        writeFileSync(join(cwd, "CLAUDE.md"), "claude");
        const files = loadProjectContextFiles({ cwd });
        expect(files).toHaveLength(1);
        expect(files[0].content).toBe("agents");
    });

    it("collects ancestor files root-most first, cwd last", () => {
        const parent = join(root, "parent");
        const cwd = join(parent, "child");
        mkdirSync(cwd, { recursive: true });
        writeFileSync(join(parent, "AGENTS.md"), "parent");
        writeFileSync(join(cwd, "AGENTS.md"), "child");
        const files = loadProjectContextFiles({ cwd });
        const contents = files.map((f) => f.content);
        expect(contents).toContain("parent");
        expect(contents).toContain("child");
        // child (cwd) must come after parent (ancestor).
        expect(contents.indexOf("parent")).toBeLessThan(contents.indexOf("child"));
    });

    it("places the global agentDir file first and dedupes by path", () => {
        const agentDir = join(root, "global");
        const cwd = join(root, "proj");
        mkdirSync(agentDir, { recursive: true });
        mkdirSync(cwd, { recursive: true });
        writeFileSync(join(agentDir, "AGENTS.md"), "global");
        writeFileSync(join(cwd, "AGENTS.md"), "local");
        const files = loadProjectContextFiles({ cwd, agentDir });
        expect(files[0].content).toBe("global");
        expect(files.map((f) => f.content)).toContain("local");
    });
});
