import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentInlineCommandResult } from "./agent-chat-host";
import { AgentCommandResult, AgentCommandResultList } from "./agent-command-result";

describe("AgentCommandResult", () => {
    it("renders ordinary command results as inline status lines", () => {
        const result: AgentInlineCommandResult = {
            command: "copy",
            status: "success",
            message: "Copied last agent message to clipboard",
        };

        const html = renderToStaticMarkup(<AgentCommandResult result={result} />);

        expect(html).toContain("Copied last agent message to clipboard");
        expect(html).toContain("text-secondary");
        expect(html).not.toContain("fixed");
        expect(html).not.toContain("absolute");
    });

    it("renders session output as a structured inline info block", () => {
        const result: AgentInlineCommandResult = {
            command: "session",
            status: "success",
            message: [
                "Session Info",
                "",
                "File: /tmp/session.jsonl",
                "ID: session-1",
                "",
                "Messages",
                "User: 2",
                "Assistant: 3",
                "",
                "Tokens",
                "Input: 1,024",
                "Output: 512",
                "",
                "Cost",
                "Total: 0.1000",
            ].join("\n"),
        };

        const html = renderToStaticMarkup(<AgentCommandResult result={result} />);

        expect(html).toContain("Session Info");
        expect(html).toContain("Messages");
        expect(html).toContain("Tokens");
        expect(html).toContain("Cost");
        expect(html).toContain("/tmp/session.jsonl");
    });

    it("renders compact success as an inline summary block", () => {
        const result: AgentInlineCommandResult = {
            command: "compact",
            status: "success",
            message: "Compacted session context.",
        };

        const html = renderToStaticMarkup(<AgentCommandResult result={result} />);

        expect(html).toContain("Context compacted");
        expect(html).toContain("Compacted session context.");
        expect(html).toContain("border-l");
    });

    it("renders noop results as inline warnings", () => {
        const result: AgentInlineCommandResult = {
            command: "compact",
            status: "noop",
            message: "No active agent session to compact.",
        };

        const html = renderToStaticMarkup(<AgentCommandResult result={result} />);

        expect(html).toContain("No active agent session to compact.");
        expect(html).toContain("text-warning");
    });

    it("renders result lists in insertion order", () => {
        const results: AgentInlineCommandResult[] = [
            { command: "copy", status: "success", message: "Copied last agent message to clipboard" },
            {
                command: "reload",
                status: "success",
                message: "Reloaded keybindings, extensions, skills, prompts, themes",
            },
        ];

        const html = renderToStaticMarkup(<AgentCommandResultList results={results} />);

        expect(html.indexOf("Copied last agent message")).toBeLessThan(html.indexOf("Reloaded keybindings"));
    });
});
