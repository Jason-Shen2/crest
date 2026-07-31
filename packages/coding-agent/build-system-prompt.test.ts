// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Skill } from "@crest/agent/harness/types";
import { buildSystemPrompt, buildSystemPromptManifest } from "./build-system-prompt";

const Skills: Skill[] = [
    {
        name: "review",
        description: "Review a change",
        content: "Full review instructions",
        filePath: "/skills/review/SKILL.md",
    },
    {
        name: "tests",
        description: "Run focused tests",
        content: "Full test instructions",
        filePath: "/skills/tests/SKILL.md",
    },
];

describe("buildSystemPromptManifest", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-01T12:00:00Z"));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("preserves the provider-visible prompt while separating semantic sources", () => {
        const inputs = {
            cwd: "/workspace",
            gitBranch: "feature/context",
            recentCmds: ["npm test"],
            selectedTools: ["read", "bash"],
            toolSnippets: { read: "Read files", bash: "Run commands" },
            appendSystemPrompt: "Local operator instruction",
            contextFiles: [
                { path: "/workspace/AGENTS.md", content: "Project rules" },
                { path: "/workspace/docs/AGENTS.md", content: "Docs rules" },
            ],
            skills: Skills,
        };

        const manifest = buildSystemPromptManifest(inputs);

        expect(manifest.text).toBe(buildSystemPrompt(inputs));
        expect(manifest.segments.map((segment) => [segment.id, segment.kind])).toEqual([
            ["agent:base", "base_prompt"],
            ["agent:append", "base_prompt"],
            ["runtime:pane", "runtime_guidance"],
            ["project:/workspace/AGENTS.md", "project_instruction"],
            ["project:/workspace/docs/AGENTS.md", "project_instruction"],
            ["skill:/skills/review/SKILL.md", "skill"],
            ["skill:/skills/tests/SKILL.md", "skill"],
            ["runtime:environment", "runtime_guidance"],
        ]);
        expect(manifest.segments[3]).toMatchObject({ path: "/workspace/AGENTS.md", text: expect.stringContaining("Project rules") });
        expect(manifest.segments[5]).toMatchObject({ skillName: "review", text: expect.stringContaining("<name>review</name>") });
    });

    it("uses the custom prompt as the stable base source", () => {
        const first = buildSystemPromptManifest({
            cwd: "/workspace",
            customPrompt: "Custom base",
            appendSystemPrompt: "Appended rule",
        });
        const second = buildSystemPromptManifest({
            cwd: "/workspace",
            customPrompt: "Custom base",
            appendSystemPrompt: "Appended rule",
        });

        expect(first.segments.map((segment) => segment.id)).toEqual([
            "agent:custom",
            "agent:append",
            "runtime:environment",
        ]);
        expect(second.segments.map((segment) => segment.id)).toEqual(first.segments.map((segment) => segment.id));
        expect(first.text).toContain("Custom base\n\nAppended rule");
    });
});
