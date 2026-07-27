import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AgentInlineCommandResult } from "./agent-chat-host";
import { AgentCommandResult, AgentCommandResultList } from "./agent-command-result";

const noop = () => {};

describe("AgentCommandResult", () => {
    it("renders ordinary command results as inline status lines", () => {
        const result: AgentInlineCommandResult = {
            command: "copy",
            status: "success",
            message: "Copied last agent message to clipboard",
        };

        const html = renderToStaticMarkup(<AgentCommandResult result={result} onDismiss={noop} />);

        expect(html).toContain("Copied last agent message to clipboard");
        expect(html).toContain("text-secondary");
        expect(html).toContain('aria-label="Dismiss"');
        expect(html).not.toContain("fixed");
    });

    it("renders session output as a structured inline info block", () => {
        const result: AgentInlineCommandResult = {
            command: "info",
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

        const html = renderToStaticMarkup(<AgentCommandResult result={result} onDismiss={noop} />);

        expect(html).toContain("Session Info");
        expect(html).toContain("Messages");
        expect(html).toContain("Tokens");
        expect(html).toContain("Cost");
        expect(html).toContain("/tmp/session.jsonl");
        expect(html).toContain('aria-label="Dismiss"');
        expect(html).toContain("rounded-2xl");
        expect(html).toContain("border-white/[0.12]");
        expect(html).toContain("bg-[rgba(34,34,36,0.62)]");
        expect(html).toContain("backdrop-blur-2xl");
        expect(html).not.toContain("rounded-t-xl");
    });

    it("renders compact success as an inline summary block", () => {
        const result: AgentInlineCommandResult = {
            command: "compact",
            status: "success",
            message: "Compacted session context.",
        };

        const html = renderToStaticMarkup(<AgentCommandResult result={result} onDismiss={noop} />);

        expect(html).toContain("Context compacted");
        expect(html).toContain("Compacted session context.");
        expect(html).toContain("text-success");
    });

    it("renders noop results as inline warnings", () => {
        const result: AgentInlineCommandResult = {
            command: "compact",
            status: "noop",
            message: "No active agent session to compact.",
        };

        const html = renderToStaticMarkup(<AgentCommandResult result={result} onDismiss={noop} />);

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

        const html = renderToStaticMarkup(<AgentCommandResultList results={results} onDismiss={noop} />);

        expect(html.indexOf("Copied last agent message")).toBeLessThan(html.indexOf("Reloaded keybindings"));
    });

    it("renders nothing when results list is empty", () => {
        const html = renderToStaticMarkup(<AgentCommandResultList results={[]} onDismiss={noop} />);

        expect(html).toBe("");
    });
});
