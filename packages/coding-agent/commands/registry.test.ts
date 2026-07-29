// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getBuiltInAgentCommands, isAgentBackendCommandReadOnly, parseAgentCommandInput } from "./registry";

describe("agent command registry", () => {
    it("includes the implemented Pi command baseline", () => {
        const names = getBuiltInAgentCommands().map((command) => command.name);
        expect(names).toEqual([
            "tree",
            "fork",
            "clone",
            "rewind",
            "redo",
            "model",
            "new",
            "compact",
            "session",
            "info",
            "copy",
            "export",
            "import",
            "reload",
        ]);
    });

    it.each([
        {
            name: "rewind",
            description: "Revert conversation and workspace to an earlier turn",
            source: "builtin",
            action: { type: "backend", command: "rewind" },
        },
        {
            name: "redo",
            description: "Restore the most recently reverted conversation and files",
            source: "builtin",
            action: { type: "backend", command: "redo" },
        },
    ] as const)("registers $name with exact rewind command metadata", (expected) => {
        expect(getBuiltInAgentCommands().find((command) => command.name === expected.name)).toEqual(expected);
    });

    it("keeps the deprecated /resume alias out of command discovery", () => {
        const names = getBuiltInAgentCommands().map((command) => command.name);

        expect(names).toContain("session");
        expect(names).toContain("info");
        expect(names).not.toContain("resume");
    });

    it("exposes /clear as an alias of /new for Claude Code compatibility", () => {
        const newCommand = getBuiltInAgentCommands().find((command) => command.name === "new");
        expect(newCommand?.aliases).toEqual(["clear"]);
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

    it("classifies frozen-safe inspection commands separately from session mutations", () => {
        for (const command of ["tree", "session", "resume", "info", "copy", "export", "reload"] as const) {
            expect(isAgentBackendCommandReadOnly(command)).toBe(true);
        }
        for (const command of ["fork", "clone", "rewind", "redo", "new", "compact", "import"] as const) {
            expect(isAgentBackendCommandReadOnly(command)).toBe(false);
        }
    });
});
