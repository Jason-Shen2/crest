// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    getAgentShellShortcutModifierKey,
    resolveEditorEnterAction,
    resolveSubmitMode,
    resolveShortcutOverrideMode,
    shouldClearInputAfterSubmit,
    shouldFocusCmdBlockEditor,
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
        expect(shouldFocusCmdBlockEditor(makeElement("DIV", { contentEditable: true }), makeContainer(false))).toBe(false);
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
