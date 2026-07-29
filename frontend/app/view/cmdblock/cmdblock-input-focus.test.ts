// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    findSlashCommandAction,
    getAgentShellShortcutModifierKey,
    makeSlashCommandsFromAgentRegistry,
    matchShellPrefix,
    resolveEditorBeforeInputAction,
    resolveEditorEnterAction,
    resolveEditorMacNavigationAction,
    resolveEditorWordBoundary,
    resolveShortcutOverrideMode,
    resolveSubmitMode,
    shouldClearInputAfterSubmit,
    shouldFocusCmdBlockEditor,
    shouldOpenSlashCommandMenu,
    shouldShowAgentShellShortcutHint,
} from "./cmdblock-input";

function makeElement(tagName: string, opts?: { contentEditable?: boolean }) {
    return {
        tagName,
        isContentEditable: opts?.contentEditable ?? false,
    } as HTMLElement;
}

function makeContainer(contains: boolean) {
    return {
        contains: () => contains,
    } as unknown as HTMLElement;
}

describe("shouldFocusCmdBlockEditor", () => {
    it("allows focus when the page body has focus", () => {
        expect(shouldFocusCmdBlockEditor(makeElement("BODY"), makeContainer(false))).toBe(true);
    });

    it("allows focus when focus is already inside the command input", () => {
        expect(shouldFocusCmdBlockEditor(makeElement("BUTTON"), makeContainer(true))).toBe(true);
    });

    it("allows focus when entering from a non-text control", () => {
        expect(shouldFocusCmdBlockEditor(makeElement("BUTTON"), makeContainer(false))).toBe(true);
    });

    it("does not steal focus from another text input", () => {
        expect(shouldFocusCmdBlockEditor(makeElement("INPUT"), makeContainer(false))).toBe(false);
    });

    it("does not steal focus from another editable surface", () => {
        expect(shouldFocusCmdBlockEditor(makeElement("DIV", { contentEditable: true }), makeContainer(false))).toBe(
            false
        );
    });
});

describe("resolveEditorEnterAction", () => {
    it("submits normally for plain Enter", () => {
        expect(resolveEditorEnterAction({ key: "Enter" })).toBe("submit");
    });

    it("submits with mode override for command or control Enter", () => {
        expect(resolveEditorEnterAction({ key: "Enter", metaKey: true })).toBe("submit-override");
        expect(resolveEditorEnterAction({ key: "Enter", ctrlKey: true })).toBe("submit-override");
    });

    it("does not submit for shift Enter", () => {
        expect(resolveEditorEnterAction({ key: "Enter", shiftKey: true })).toBeNull();
    });
});

describe("resolveEditorMacNavigationAction", () => {
    it("clears the editor for Command Backspace", () => {
        expect(resolveEditorMacNavigationAction({ key: "Backspace", metaKey: true })).toBe("clear-all");
    });

    it("moves by word for Option arrows", () => {
        expect(resolveEditorMacNavigationAction({ key: "ArrowLeft", altKey: true })).toBe("word-left");
        expect(resolveEditorMacNavigationAction({ key: "ArrowRight", altKey: true })).toBe("word-right");
    });

    it("does not intercept plain deletion or arrows", () => {
        expect(resolveEditorMacNavigationAction({ key: "Backspace" })).toBeNull();
        expect(resolveEditorMacNavigationAction({ key: "ArrowLeft" })).toBeNull();
        expect(resolveEditorMacNavigationAction({ key: "ArrowRight" })).toBeNull();
    });
});

describe("resolveEditorBeforeInputAction", () => {
    it("clears the editor for macOS Command Backspace beforeinput variants", () => {
        expect(resolveEditorBeforeInputAction("deleteHardLineBackward")).toBe("clear-all");
        expect(resolveEditorBeforeInputAction("deleteSoftLineBackward")).toBe("clear-all");
    });

    it("does not intercept ordinary content deletion", () => {
        expect(resolveEditorBeforeInputAction("deleteContentBackward")).toBeNull();
        expect(resolveEditorBeforeInputAction("deleteWordBackward")).toBeNull();
    });
});

describe("resolveEditorWordBoundary", () => {
    it("moves left to the start of the previous shell token", () => {
        expect(resolveEditorWordBoundary("git commit --amend", 18, "left")).toBe(11);
        expect(resolveEditorWordBoundary("git commit   --amend", 13, "left")).toBe(4);
    });

    it("moves right to the end of the next shell token", () => {
        expect(resolveEditorWordBoundary("git commit --amend", 0, "right")).toBe(3);
        expect(resolveEditorWordBoundary("git   commit --amend", 3, "right")).toBe(12);
    });
});

describe("resolveShortcutOverrideMode", () => {
    it("flips the current submit target", () => {
        expect(resolveShortcutOverrideMode("agent")).toBe("terminal");
        expect(resolveShortcutOverrideMode("terminal")).toBe("agent");
    });
});

describe("resolveSubmitMode", () => {
    it("resolves locked and auto modes", () => {
        expect(resolveSubmitMode("agent")).toBe("agent");
        expect(resolveSubmitMode("terminal")).toBe("terminal");
        expect(resolveSubmitMode("auto", "agent")).toBe("agent");
        expect(resolveSubmitMode("auto", "terminal")).toBe("terminal");
        expect(resolveSubmitMode("auto")).toBe("agent");
    });
});

describe("matchShellPrefix", () => {
    it("strips the prefix in agent-capable modes", () => {
        expect(matchShellPrefix("agent", "!ls -al")).toBe("ls -al");
        expect(matchShellPrefix("auto", "  !  git status")).toBe("git status");
    });

    it("keeps `!` literal in terminal mode (shell history expansion)", () => {
        expect(matchShellPrefix("terminal", "!ls")).toBeNull();
        expect(matchShellPrefix("terminal", "!!")).toBeNull();
    });

    it("returns an empty payload for a bare prefix so callers can no-op", () => {
        expect(matchShellPrefix("agent", "!")).toBe("");
        expect(matchShellPrefix("agent", "!   ")).toBe("");
    });

    it("does not fire without a leading prefix", () => {
        expect(matchShellPrefix("agent", "echo hi!")).toBeNull();
        expect(matchShellPrefix("agent", "explain this")).toBeNull();
    });

    it("preserves newlines in a multiline shell payload", () => {
        expect(matchShellPrefix("agent", "!for f in *; do\necho $f\ndone")).toBe("for f in *; do\necho $f\ndone");
    });
});

describe("shouldClearInputAfterSubmit", () => {
    it("keeps the draft when submit was rejected", () => {
        expect(shouldClearInputAfterSubmit(false)).toBe(false);
    });

    it("clears the draft for accepted or legacy submit handlers", () => {
        expect(shouldClearInputAfterSubmit(true)).toBe(true);
        expect(shouldClearInputAfterSubmit(undefined)).toBe(true);
    });
});

describe("shouldShowAgentShellShortcutHint", () => {
    it("shows only for typed input in agent mode", () => {
        expect(shouldShowAgentShellShortcutHint("agent", "explain this")).toBe(true);
        expect(shouldShowAgentShellShortcutHint("agent", "   ")).toBe(false);
        expect(shouldShowAgentShellShortcutHint("auto", "explain this")).toBe(false);
        expect(shouldShowAgentShellShortcutHint("terminal", "explain this")).toBe(false);
    });
});

describe("getAgentShellShortcutModifierKey", () => {
    it("uses native symbol modifier keys", () => {
        expect(getAgentShellShortcutModifierKey(true)).toBe("⌘");
        expect(getAgentShellShortcutModifierKey(false)).toBe("⌃");
    });
});

describe("makeSlashCommandsFromAgentRegistry", () => {
    it("uses agent command registry metadata for builtin slash commands", () => {
        const commands = makeSlashCommandsFromAgentRegistry([
            {
                name: "tree",
                description: "Navigate the current agent session tree",
                source: "builtin",
                action: { type: "backend", command: "tree" },
            },
            {
                name: "model",
                description: "Open the model picker",
                source: "builtin",
                action: { type: "frontend", action: "openModelPicker" },
            },
            {
                name: "compact",
                description: "Compact the current session context",
                argumentHint: "[instructions]",
                source: "builtin",
                action: { type: "backend", command: "compact" },
            },
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
        ]);

        expect(commands).toEqual([
            {
                name: "/tree",
                description: "Navigate the current agent session tree",
                icon: "git-branch-01",
                action: "submitAgentCommand",
            },
            {
                name: "/model",
                description: "Open the model picker",
                icon: "stars-01",
                action: "openModelPicker",
            },
            {
                name: "/compact",
                description: "Compact the current session context [instructions]",
                icon: "archive",
                action: "submitAgentCommand",
            },
            {
                name: "/rewind",
                description: "Revert conversation and workspace to an earlier turn",
                icon: "RotateCcw",
                action: "submitAgentCommand",
            },
            {
                name: "/redo",
                description: "Restore the most recently reverted conversation and files",
                icon: "RotateCw",
                action: "submitAgentCommand",
            },
        ]);
    });

    it("marks builtin backend slash commands as agent actions", () => {
        const commands = makeSlashCommandsFromAgentRegistry([
            {
                name: "tree",
                description: "Navigate the current agent session tree",
                source: "builtin",
                action: { type: "backend", command: "tree" },
            },
            {
                name: "fork",
                description: "Fork a new agent session from a previous user message",
                source: "builtin",
                action: { type: "backend", command: "fork" },
            },
            {
                name: "export",
                description: "Export the current session as JSONL",
                argumentHint: "[path]",
                source: "builtin",
                action: { type: "backend", command: "export" },
            },
        ]);

        expect(commands.map((command) => ({ name: command.name, action: command.action }))).toEqual([
            { name: "/tree", action: "submitAgentCommand" },
            { name: "/fork", action: "submitAgentCommand" },
            { name: "/export", action: "submitAgentCommand" },
        ]);
    });
});

describe("shouldOpenSlashCommandMenu", () => {
    it("does not open agent slash commands in terminal mode", () => {
        expect(shouldOpenSlashCommandMenu("terminal", "/")).toBe(false);
        expect(shouldOpenSlashCommandMenu("terminal", "/tree")).toBe(false);
    });

    it("opens slash commands in agent-capable modes", () => {
        expect(shouldOpenSlashCommandMenu("agent", "/")).toBe(true);
        expect(shouldOpenSlashCommandMenu("auto", "/model")).toBe(true);
        expect(shouldOpenSlashCommandMenu("agent", "echo /tmp")).toBe(false);
    });
});

describe("findSlashCommandAction", () => {
    it("routes exact backend slash commands through the agent in agent mode", () => {
        expect(
            findSlashCommandAction(
                [
                    { name: "/tree", action: "submitAgentCommand" },
                    { name: "/model", action: "openModelPicker" },
                    { name: "/rewind", action: "submitAgentCommand" },
                    { name: "/redo", action: "submitAgentCommand" },
                ],
                "/tree ",
                "agent"
            )
        ).toBe("submitAgentCommand");
        expect(
            findSlashCommandAction(
                [
                    { name: "/rewind", action: "submitAgentCommand" },
                    { name: "/redo", action: "submitAgentCommand" },
                ],
                "/rewind ",
                "agent"
            )
        ).toBe("submitAgentCommand");
        expect(
            findSlashCommandAction(
                [
                    { name: "/rewind", action: "submitAgentCommand" },
                    { name: "/redo", action: "submitAgentCommand" },
                ],
                "/redo ",
                "agent"
            )
        ).toBe("submitAgentCommand");
    });

    it("does not route slash commands away from the shell in terminal mode", () => {
        expect(
            findSlashCommandAction([{ name: "/tree", action: "submitAgentCommand" }], "/tree ", "terminal")
        ).toBeUndefined();
    });

    it("does not treat slash commands with arguments as exact immediate actions", () => {
        expect(
            findSlashCommandAction([{ name: "/tree", action: "submitAgentCommand" }], "/tree extra")
        ).toBeUndefined();
    });
});
