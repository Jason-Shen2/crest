// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getBuiltInAgentCommands, parseAgentCommandInput } from "./registry";

describe("agent command registry", () => {
    it("includes session-tree commands", () => {
        const names = getBuiltInAgentCommands().map((command) => command.name);
        expect(names).toContain("tree");
        expect(names).toContain("fork");
        expect(names).toContain("clone");
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
});
