// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getBuiltInAgentCommands, parseAgentCommandInput } from "./registry";

describe("agent command registry", () => {
    it("includes the implemented Pi command baseline", () => {
        const names = getBuiltInAgentCommands().map((command) => command.name);
        expect(names).toEqual([
            "tree",
            "fork",
            "clone",
            "model",
            "new",
            "resume",
            "compact",
            "session",
            "copy",
            "export",
            "import",
            "reload",
        ]);
    });

    it("parses slash command input", () => {
        expect(parseAgentCommandInput("/tree")).toEqual({ commandName: "tree", argsText: "" });
        expect(parseAgentCommandInput("/fork   entry text")).toEqual({
            commandName: "fork",
            argsText: "entry text",
        });
    });

    it("ignores non-command input and bare slash", () => {
        expect(parseAgentCommandInput("hello")).toBeUndefined();
        expect(parseAgentCommandInput("/")).toBeUndefined();
        expect(parseAgentCommandInput(" /tree")).toBeUndefined();
    });

    it("keeps argument text for commands that need arguments", () => {
        expect(parseAgentCommandInput("/compact keep recent errors")).toEqual({
            commandName: "compact",
            argsText: "keep recent errors",
        });
        expect(parseAgentCommandInput("/export /tmp/session.jsonl")).toEqual({
            commandName: "export",
            argsText: "/tmp/session.jsonl",
        });
        expect(parseAgentCommandInput("/import /tmp/session.jsonl")).toEqual({
            commandName: "import",
            argsText: "/tmp/session.jsonl",
        });
    });
});
