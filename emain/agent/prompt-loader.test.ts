// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultPromptTemplateDirs, loadAgentPromptTemplates } from "./prompt-loader";

function writeJson(path: string, value: unknown): void {
    writeFileSync(path, JSON.stringify(value, null, 2));
}

function writePrompt(dir: string, name: string, description: string, body = "Prompt body."): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), `---\ndescription: ${description}\n---\n${body}\n`);
}

describe("defaultPromptTemplateDirs", () => {
    it("returns configHome/prompts first, then cwd/.crest/prompts", () => {
        const dirs = defaultPromptTemplateDirs("/work/proj", "/tmp/crest-cfg");
        expect(dirs).toEqual([join("/tmp/crest-cfg", "prompts"), join("/work/proj", ".crest", "prompts")]);
    });
});

describe("loadAgentPromptTemplates", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "crest-prompts-"));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it("loads prompt templates declared by an extension package pi.prompts manifest", async () => {
        const cwd = join(root, "proj");
        const packageDir = join(cwd, ".crest", "extensions", "prompt-pack");
        const promptsDir = join(packageDir, "prompts");
        mkdirSync(promptsDir, { recursive: true });
        writeJson(join(packageDir, "package.json"), { pi: { prompts: ["prompts"] } });
        writePrompt(promptsDir, "handoff", "Create a handoff summary.", "Summarize this session.");

        const prompts = await loadAgentPromptTemplates({ cwd, configHome: join(root, "cfg") });
        expect(prompts.map((p) => p.name)).toContain("handoff");
        expect(prompts.find((p) => p.name === "handoff")?.description).toBe("Create a handoff summary.");
    });
});
