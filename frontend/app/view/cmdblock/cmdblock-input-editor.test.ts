// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { getEditorCaretOffset, getEditorPlainText } from "./cmdblock-input";

function editorWith(html: string): HTMLDivElement {
    const el = document.createElement("div");
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
}

describe("getEditorPlainText", () => {
    it("preserves <br> line breaks that textContent drops", () => {
        const el = editorWith("line1<br>line2");
        expect(el.textContent).toBe("line1line2");
        expect(getEditorPlainText(el)).toBe("line1\nline2");
    });

    it("treats block-level children (pasted lines) as line breaks", () => {
        const el = editorWith("line1<div>line2</div><div>line3</div>");
        expect(getEditorPlainText(el)).toBe("line1\nline2\nline3");
    });

    it("drops the single trailing caret-placeholder <br>", () => {
        const el = editorWith("cmd<br><br>");
        expect(getEditorPlainText(el)).toBe("cmd\n");
    });

    it("round-trips a plain single-line buffer", () => {
        const el = editorWith("git status");
        expect(getEditorPlainText(el)).toBe("git status");
        expect(getEditorPlainText(editorWith(""))).toBe("");
    });

    it("prefers innerText when the environment provides it", () => {
        const fake = { innerText: "a\nb\n" } as unknown as HTMLElement;
        expect(getEditorPlainText(fake)).toBe("a\nb");
    });
});

describe("getEditorCaretOffset", () => {
    function placeCaret(el: HTMLElement, node: Node, offset: number): void {
        const range = document.createRange();
        range.setStart(node, offset);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }

    it("reports the caret position inside the editor, not end-of-buffer", () => {
        const el = editorWith("cd /tmp && ls");
        placeCaret(el, el.firstChild, 7);
        expect(getEditorCaretOffset(el)).toBe(7);
    });

    it("returns null when the selection lives outside the editor", () => {
        const el = editorWith("inside");
        const other = editorWith("outside");
        placeCaret(other, other.firstChild, 2);
        expect(getEditorCaretOffset(el)).toBeNull();
    });
});
