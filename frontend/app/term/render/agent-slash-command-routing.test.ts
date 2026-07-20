// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveAgentSlashCommandRoute } from "./agent-slash-command-routing";

describe("resolveAgentSlashCommandRoute", () => {
    it("routes builtin agent slash commands before prompt submission", () => {
        expect(resolveAgentSlashCommandRoute("/tree")).toEqual({
            handled: true,
            kind: "builtin",
            command: "tree",
            argsText: "",
        });
        expect(resolveAgentSlashCommandRoute("/fork previous turn")).toEqual({
            handled: true,
            kind: "builtin",
            command: "fork",
            argsText: "previous turn",
        });
        expect(resolveAgentSlashCommandRoute("/clone")).toEqual({
            handled: true,
            kind: "builtin",
            command: "clone",
            argsText: "",
        });
        expect(resolveAgentSlashCommandRoute("/model")).toEqual({
            handled: true,
            kind: "builtin",
            command: "model",
            argsText: "",
        });
    });

    it.each(["new", "resume", "compact", "session", "copy", "export", "import", "reload"] as const)(
        "routes /%s as a handled agent command",
        (command) => {
            expect(resolveAgentSlashCommandRoute(`/${command}`)).toEqual({
                handled: true,
                kind: "builtin",
                command,
                argsText: "",
            });
        }
    );

    it("preserves arguments for command execution", () => {
        expect(resolveAgentSlashCommandRoute("/compact keep the latest failure context")).toEqual({
            handled: true,
            kind: "builtin",
            command: "compact",
            argsText: "keep the latest failure context",
        });
    });

    it("routes extension-registered command names when supplied", () => {
        const extensionNames = new Set(["deploy"]);
        expect(resolveAgentSlashCommandRoute("/deploy staging", extensionNames)).toEqual({
            handled: true,
            kind: "extension",
            name: "deploy",
            argsText: "staging",
        });
    });

    it("leaves prompts and unknown commands on the normal send path", () => {
        expect(resolveAgentSlashCommandRoute("explain /tree")).toEqual({ handled: false });
        expect(resolveAgentSlashCommandRoute("/unknown")).toEqual({ handled: false });
        expect(resolveAgentSlashCommandRoute("/")).toEqual({ handled: false });
    });
});
