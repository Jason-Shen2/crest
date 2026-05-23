// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// build-system-prompt.ts — composes the system prompt fed to the LLM
// for a given pane invocation. Called per turn (via the function-form
// systemPrompt option on AgentHarness) so cwd / git / recent-cmds
// updates between sends are reflected immediately. See
// docs/agent-runtime-architecture.md §5.3 / §5.4.
//
// Kept separate from pi's harness/system-prompt.ts because pi's helper
// targets its standalone CLI's context surface; crest's surface is
// terminal-pane state, which is different enough that adapters through
// pi's helper would be more code than just writing our own composer.

const BASE_INSTRUCTIONS = `You are an AI assistant integrated into crest, a modern terminal.
Help the user with terminal-centric coding tasks: running shell commands, reading and writing files, navigating their project.
Prefer concise answers. When uncertain, ask one clarifying question rather than guessing.`;

export interface SystemPromptInputs {
    /** Pane's current working directory (absolute path). */
    cwd: string;
    /** Active git branch in cwd, if any. Omitted when not a git repo. */
    gitBranch?: string;
    /** Connection name when the pane is on a remote SSH host. "local" is skipped. */
    connection?: string;
    /** Last few commands the user ran in this pane, oldest → newest. Capped to 5 in the rendered prompt. */
    recentCmds?: string[];
}

export function buildSystemPrompt(inputs: SystemPromptInputs): string {
    const lines: string[] = [BASE_INSTRUCTIONS, "", "## Pane context", `- cwd: ${inputs.cwd}`];
    if (inputs.gitBranch) lines.push(`- git branch: ${inputs.gitBranch}`);
    if (inputs.connection && inputs.connection !== "local") {
        lines.push(`- connection: ${inputs.connection}`);
    }
    if (inputs.recentCmds && inputs.recentCmds.length > 0) {
        lines.push("", "## Recent commands", ...inputs.recentCmds.slice(-5).map((c) => `- ${c}`));
    }
    return lines.join("\n");
}
