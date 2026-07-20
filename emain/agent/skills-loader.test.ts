// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSkillDirs, loadAgentSkills } from "./skills-loader";

function writeSkill(dir: string, name: string, description: string, body = "Do the thing."): void {
    const skillDir = join(dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

function writeJson(path: string, value: unknown): void {
    writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("defaultSkillDirs", () => {
    const saved = { ...process.env };
    afterEach(() => {
        process.env = { ...saved };
    });

    it("returns configHome/skills first, then cwd/.crest/skills", () => {
        process.env.WAVETERM_CONFIG_HOME = "/tmp/crest-cfg";
        delete process.env.WAVETERM_DEV;
        const dirs = defaultSkillDirs("/work/proj");
        expect(dirs).toEqual([join("/tmp/crest-cfg", "skills"), join("/work/proj", ".crest", "skills")]);
    });
});

describe("loadAgentSkills", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "crest-skills-"));
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it("returns [] when no skill dirs exist", async () => {
        const cwd = join(root, "proj");
        mkdirSync(cwd, { recursive: true });
        const skills = await loadAgentSkills({ cwd, configHome: join(root, "missing-cfg") });
        expect(skills).toEqual([]);
    });

    it("loads a project-local skill from cwd/.crest/skills", async () => {
        const cwd = join(root, "proj");
        const skillsDir = join(cwd, ".crest", "skills");
        mkdirSync(skillsDir, { recursive: true });
        writeSkill(skillsDir, "format-code", "Format the code base.");
        const skills = await loadAgentSkills({ cwd, configHome: join(root, "cfg") });
        expect(skills.map((s) => s.name)).toContain("format-code");
        const skill = skills.find((s) => s.name === "format-code");
        expect(skill?.description).toBe("Format the code base.");
    });

    it("loads a global skill from configHome/skills", async () => {
        const cwd = join(root, "proj");
        mkdirSync(cwd, { recursive: true });
        const configHome = join(root, "cfg");
        const skillsDir = join(configHome, "skills");
        mkdirSync(skillsDir, { recursive: true });
        writeSkill(skillsDir, "global-skill", "A global skill.");
        const skills = await loadAgentSkills({ cwd, configHome });
        expect(skills.map((s) => s.name)).toContain("global-skill");
    });

    it("loads from both global and project dirs", async () => {
        const cwd = join(root, "proj");
        const configHome = join(root, "cfg");
        const globalDir = join(configHome, "skills");
        const projDir = join(cwd, ".crest", "skills");
        mkdirSync(globalDir, { recursive: true });
        mkdirSync(projDir, { recursive: true });
        writeSkill(globalDir, "global-skill", "Global.");
        writeSkill(projDir, "project-skill", "Project.");
        const skills = await loadAgentSkills({ cwd, configHome });
        const names = skills.map((s) => s.name);
        expect(names).toContain("global-skill");
        expect(names).toContain("project-skill");
    });

    it("loads skills declared by an extension package pi.skills manifest", async () => {
        const cwd = join(root, "proj");
        const packageDir = join(cwd, ".crest", "extensions", "skill-pack");
        const skillsDir = join(packageDir, "skills");
        mkdirSync(skillsDir, { recursive: true });
        writeJson(join(packageDir, "package.json"), { pi: { skills: ["skills"] } });
        writeSkill(skillsDir, "pack-skill", "Skill from extension package.");

        const skills = await loadAgentSkills({ cwd, configHome: join(root, "cfg") });
        expect(skills.map((s) => s.name)).toContain("pack-skill");
    });
});
