// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// build-system-prompt.ts — composes the system prompt fed to the LLM
// for a given pane invocation. Called per turn (via the function-form
// systemPrompt option on AgentHarness) so cwd / git / recent-cmds /
// active-tools updates between sends are reflected immediately. See
// docs/agent-runtime-architecture.md §5.3 / §5.4.
//
// The default-prompt body, Available-tools list, Guidelines assembly,
// <project_context> injection, skills section, and date/cwd footer are
// ported from pi's packages/coding-agent/src/core/system-prompt.ts
// (earendil-works/pi, MIT). pi's "Pi documentation" block is dropped
// (crest is not the pi CLI). crest's pane state (git branch / remote
// connection / recent commands) is appended as an extra section.

import { formatSkillsForSystemPrompt } from "@crest/agent/harness/system-prompt";
import type { Skill } from "@crest/agent/harness/types";

export interface SystemPromptInputs {
    /** Pane's current working directory (absolute path). */
    cwd: string;
    /** Active git branch in cwd, if any. Omitted when not a git repo. */
    gitBranch?: string;
    /** Connection name when the pane is on a remote SSH host. "local" is skipped. */
    connection?: string;
    /** Last few commands the user ran in this pane, oldest → newest. Capped to 5 in the rendered prompt. */
    recentCmds?: string[];
    /** Custom system prompt (replaces the default body). Ported from pi. */
    customPrompt?: string;
    /** Names of the tools active for this turn. Default: [read, bash, edit, write]. */
    selectedTools?: string[];
    /** One-line tool snippets keyed by tool name; drives the Available tools section. */
    toolSnippets?: Record<string, string>;
    /** Additional guideline bullets appended to the default Guidelines section. */
    promptGuidelines?: string[];
    /** Text appended verbatim to the system prompt. Ported from pi. */
    appendSystemPrompt?: string;
    /** Pre-loaded project context files (AGENTS.md / CLAUDE.md). */
    contextFiles?: Array<{ path: string; content: string }>;
    /** Pre-loaded skills. Injected only when the read tool is available. */
    skills?: Skill[];
}

/** Render crest's pane-state section (git branch / connection / recent commands). */
function buildPaneContextSection(inputs: SystemPromptInputs): string {
    const lines: string[] = [];
    if (inputs.gitBranch) lines.push(`- git branch: ${inputs.gitBranch}`);
    if (inputs.connection && inputs.connection !== "local") {
        lines.push(`- connection: ${inputs.connection}`);
    }
    if (inputs.recentCmds && inputs.recentCmds.length > 0) {
        lines.push("", "## Recent commands", ...inputs.recentCmds.slice(-5).map((c) => `- ${c}`));
    }
    if (lines.length === 0) return "";
    return `\n\n## Pane context\n${lines.join("\n")}`;
}

/** Build the system prompt with tools, guidelines, project context, skills, and pane state. */
export function buildSystemPrompt(inputs: SystemPromptInputs): string {
    const {
        customPrompt,
        selectedTools,
        toolSnippets,
        promptGuidelines,
        appendSystemPrompt,
        cwd,
        contextFiles: providedContextFiles,
        skills: providedSkills,
    } = inputs;
    const promptCwd = cwd.replace(/\\/g, "/");

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    const date = `${year}-${month}-${day}`;

    const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
    const paneContext = buildPaneContextSection(inputs);
    const contextFiles = providedContextFiles ?? [];
    const skills = providedSkills ?? [];

    const renderProjectContext = (): string => {
        if (contextFiles.length === 0) return "";
        let section = "\n\n<project_context>\n\n";
        section += "Project-specific instructions and guidelines:\n\n";
        for (const { path: filePath, content } of contextFiles) {
            section += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
        }
        section += "</project_context>\n";
        return section;
    };

    if (customPrompt) {
        let prompt = customPrompt;
        if (appendSection) prompt += appendSection;
        prompt += paneContext;
        prompt += renderProjectContext();
        const customHasRead = !selectedTools || selectedTools.includes("read");
        if (customHasRead && skills.length > 0) prompt += formatSkillsForSystemPrompt(skills);
        prompt += `\nCurrent date: ${date}`;
        prompt += `\nCurrent working directory: ${promptCwd}`;
        return prompt;
    }

    // Build the Available tools list. A tool appears only when the caller
    // provides a one-line snippet for it.
    const tools = selectedTools || ["read", "bash", "edit", "write"];
    const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
    const toolsList =
        visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

    // Build guidelines based on which tools are actually available.
    const guidelinesList: string[] = [];
    const guidelinesSet = new Set<string>();
    const addGuideline = (guideline: string): void => {
        if (guidelinesSet.has(guideline)) return;
        guidelinesSet.add(guideline);
        guidelinesList.push(guideline);
    };

    const hasBash = tools.includes("bash");
    const hasGrep = tools.includes("grep");
    const hasFind = tools.includes("find");
    const hasLs = tools.includes("ls");
    const hasRead = tools.includes("read");

    if (hasBash && !hasGrep && !hasFind && !hasLs) {
        addGuideline("Use bash for file operations like ls, rg, find");
    }

    for (const guideline of promptGuidelines ?? []) {
        const normalized = guideline.trim();
        if (normalized.length > 0) addGuideline(normalized);
    }

    addGuideline("Be concise in your responses");
    addGuideline("Show file paths clearly when working with files");

    const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

    let prompt = `You are an expert coding assistant operating inside crest, a modern terminal with an integrated coding agent. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}`;

    if (appendSection) prompt += appendSection;
    prompt += paneContext;
    prompt += renderProjectContext();
    if (hasRead && skills.length > 0) prompt += formatSkillsForSystemPrompt(skills);
    prompt += `\nCurrent date: ${date}`;
    prompt += `\nCurrent working directory: ${promptCwd}`;

    return prompt;
}
