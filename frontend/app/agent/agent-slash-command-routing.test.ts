// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { isAgentSlashCommandReadOnly, resolveAgentSlashCommandRoute } from "./agent-slash-command-routing";

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
        expect(resolveAgentSlashCommandRoute("/rewind")).toEqual({
            handled: true,
            command: "rewind",
            argsText: "",
        });
        expect(resolveAgentSlashCommandRoute("/redo")).toEqual({ handled: true, command: "redo", argsText: "" });
    });

    it.each(["new", "compact", "session", "info", "copy", "export", "import", "reload"] as const)(
        "routes /%s as a handled agent command",
        (command) => {
            expect(resolveAgentSlashCommandRoute(`/${command}`)).toEqual({
                handled: true,
                command,
                argsText: "",
            });
        }
    );

    it("normalizes the hidden /resume compatibility alias to /session", () => {
        expect(resolveAgentSlashCommandRoute("/resume ignored")).toEqual({
            handled: true,
            command: "session",
            argsText: "",
        });
    });

    it("preserves arguments for command execution", () => {
        expect(resolveAgentSlashCommandRoute("/compact keep the latest failure context")).toEqual({
            handled: true,
            command: "compact",
            argsText: "keep the latest failure context",
        });
    });

    it("leaves prompts and unknown commands on the normal send path", () => {
        expect(resolveAgentSlashCommandRoute("explain /tree")).toEqual({ handled: false });
        expect(resolveAgentSlashCommandRoute("/unknown")).toEqual({ handled: false });
        expect(resolveAgentSlashCommandRoute("/")).toEqual({ handled: false });
    });

    it("reuses backend command access metadata for frozen slash routing", () => {
        for (const command of [
            "/tree",
            "/session",
            "/resume",
            "/info",
            "/copy",
            "/export out.jsonl",
            "/reload",
            "/model",
        ]) {
            expect(isAgentSlashCommandReadOnly(command)).toBe(true);
        }
        for (const command of [
            "plain prompt",
            "/fork",
            "/clone",
            "/rewind",
            "/redo",
            "/new",
            "/compact",
            "/import in.jsonl",
        ]) {
            expect(isAgentSlashCommandReadOnly(command)).toBe(false);
        }
    });
});
