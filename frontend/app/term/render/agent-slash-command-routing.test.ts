// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveAgentSlashCommandRoute } from "./agent-slash-command-routing";

describe("resolveAgentSlashCommandRoute", () => {
    it("routes builtin agent slash commands before prompt submission", () => {
        expect(resolveAgentSlashCommandRoute("/tree")).toEqual({ handled: true, command: "tree", argsText: "" });
        expect(resolveAgentSlashCommandRoute("/fork previous turn")).toEqual({
            handled: true,
            command: "fork",
            argsText: "previous turn",
        });
        expect(resolveAgentSlashCommandRoute("/clone")).toEqual({ handled: true, command: "clone", argsText: "" });
        expect(resolveAgentSlashCommandRoute("/model")).toEqual({ handled: true, command: "model", argsText: "" });
    });

    it("leaves prompts and unknown commands on the normal send path", () => {
        expect(resolveAgentSlashCommandRoute("explain /tree")).toEqual({ handled: false });
        expect(resolveAgentSlashCommandRoute("/unknown")).toEqual({ handled: false });
        expect(resolveAgentSlashCommandRoute("/")).toEqual({ handled: false });
    });
});
