// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Representative scenarios for the agent regression harness. Each scenario
// is a prompt plus a `check` over what the agent actually did (tool calls,
// tool results, final text, stop reason). LLM output is non-deterministic,
// so checks assert on *behavior* (did it call ls? did the final text
// mention the marker?) rather than exact strings.

export interface RunCapture {
    toolCalls: { name: string; args: unknown }[];
    toolResults: { name: string; isError: boolean }[];
    finalText: string;
    stopReason?: string;
    errorMessage?: string;
    turnCount: number;
}

export interface Scenario {
    id: string;
    // {cwd} is substituted with the run's working directory.
    prompt: string;
    // Returns a list of failure messages. Empty array = pass.
    check: (cap: RunCapture) => string[];
}

function calledTool(cap: RunCapture, name: string): boolean {
    return cap.toolCalls.some((c) => c.name === name);
}

function noToolErrors(cap: RunCapture): string[] {
    const errs = cap.toolResults.filter((r) => r.isError);
    return errs.map((e) => `tool "${e.name}" returned an error result`);
}

function notErrored(cap: RunCapture): string[] {
    if (cap.stopReason === "error") {
        return [`agent stopped with error: ${cap.errorMessage ?? "(no message)"}`];
    }
    return [];
}

function textIncludes(cap: RunCapture, needle: string): boolean {
    return cap.finalText.toLowerCase().includes(needle.toLowerCase());
}

export const SCENARIOS: Scenario[] = [
    {
        id: "text-only",
        prompt: "Reply with exactly the word OK and nothing else. Do not call any tools.",
        check: (cap) => {
            const fails = notErrored(cap);
            if (cap.toolCalls.length > 0) {
                fails.push(`expected no tool calls, got ${cap.toolCalls.length}`);
            }
            if (!textIncludes(cap, "ok")) {
                fails.push(`expected final text to contain "OK", got: ${JSON.stringify(cap.finalText.slice(0, 120))}`);
            }
            return fails;
        },
    },
    {
        id: "list-dir",
        prompt: "List the files and directories in {cwd} using the ls tool, then briefly summarize what you found.",
        check: (cap) => {
            const fails = [...notErrored(cap), ...noToolErrors(cap)];
            if (!calledTool(cap, "ls")) {
                fails.push(`expected ls to be called; tools called: ${cap.toolCalls.map((c) => c.name).join(", ") || "(none)"}`);
            }
            return fails;
        },
    },
    {
        id: "read-file",
        prompt: 'Read the file {cwd}/package.json with the read tool and tell me the exact value of its top-level "name" field.',
        check: (cap) => {
            const fails = [...notErrored(cap), ...noToolErrors(cap)];
            if (!calledTool(cap, "read")) {
                fails.push(`expected read to be called; tools called: ${cap.toolCalls.map((c) => c.name).join(", ") || "(none)"}`);
            }
            // package.json name is "crest".
            if (!textIncludes(cap, "crest")) {
                fails.push(`expected final text to mention the package name "crest", got: ${JSON.stringify(cap.finalText.slice(0, 160))}`);
            }
            return fails;
        },
    },
    {
        id: "shell-exec",
        prompt: "Run the shell command: echo regression-marker-42 — using the bash tool, and report its exact stdout.",
        check: (cap) => {
            const fails = [...notErrored(cap), ...noToolErrors(cap)];
            if (!calledTool(cap, "bash")) {
                fails.push(`expected bash to be called; tools called: ${cap.toolCalls.map((c) => c.name).join(", ") || "(none)"}`);
            }
            if (!textIncludes(cap, "regression-marker-42")) {
                fails.push(`expected final text to echo "regression-marker-42", got: ${JSON.stringify(cap.finalText.slice(0, 160))}`);
            }
            return fails;
        },
    },
    {
        id: "multi-step",
        prompt: "First list the files in {cwd}, then read the package.json you find there and report its \"name\" field. Use the tools.",
        check: (cap) => {
            const fails = [...notErrored(cap), ...noToolErrors(cap)];
            if (cap.toolCalls.length < 2) {
                fails.push(`expected at least 2 tool calls (list then read), got ${cap.toolCalls.length}: ${cap.toolCalls.map((c) => c.name).join(", ")}`);
            }
            if (!calledTool(cap, "read")) {
                fails.push("expected read among the tool calls");
            }
            return fails;
        },
    },
    {
        id: "find",
        prompt: "Use the find tool to list the TypeScript files (*.ts) under {cwd}, then say how many you found.",
        check: (cap) => {
            const fails = [...notErrored(cap), ...noToolErrors(cap)];
            if (!calledTool(cap, "find")) {
                fails.push(`expected find to be called; tools called: ${cap.toolCalls.map((c) => c.name).join(", ") || "(none)"}`);
            }
            return fails;
        },
    },
    {
        id: "grep",
        prompt: 'Use the grep tool to find which lines in {cwd}/package.json contain the text "crest", and report them.',
        check: (cap) => {
            const fails = [...notErrored(cap), ...noToolErrors(cap)];
            if (!calledTool(cap, "grep")) {
                fails.push(`expected grep to be called; tools called: ${cap.toolCalls.map((c) => c.name).join(", ") || "(none)"}`);
            }
            if (!textIncludes(cap, "crest")) {
                fails.push(`expected final text to mention "crest", got: ${JSON.stringify(cap.finalText.slice(0, 160))}`);
            }
            return fails;
        },
    },
    {
        // Autonomous tool selection: the prompt asks a question that can only
        // be answered by reading a file, but it never names a tool. This is
        // the scenario class the audit flagged — it verifies the agent picks
        // an appropriate tool on its own (the symptom of the "dumb" agent was
        // answering from guesswork instead of inspecting the file). It must
        // (a) call at least one tool, and (b) surface the real answer.
        id: "autonomous-answer",
        prompt: 'What is the exact value of the top-level "name" field in {cwd}/package.json?',
        check: (cap) => {
            const fails = [...notErrored(cap), ...noToolErrors(cap)];
            if (cap.toolCalls.length === 0) {
                fails.push("expected the agent to call a tool to inspect the file, but it called none");
            }
            // package.json name is "crest". Getting it right requires actually
            // reading the file rather than hallucinating.
            if (!textIncludes(cap, "crest")) {
                fails.push(`expected final text to report the package name "crest", got: ${JSON.stringify(cap.finalText.slice(0, 160))}`);
            }
            return fails;
        },
    },
];
