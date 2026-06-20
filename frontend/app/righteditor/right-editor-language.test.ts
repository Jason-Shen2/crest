// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { getRightEditorLanguage } from "./right-editor-language";

describe("getRightEditorLanguage", () => {
    it("maps common source files to Monaco language ids", () => {
        expect(getRightEditorLanguage("/repo/src/app.ts")).toBe("typescript");
        expect(getRightEditorLanguage("/repo/src/app.tsx")).toBe("typescript");
        expect(getRightEditorLanguage("/repo/src/app.js")).toBe("javascript");
        expect(getRightEditorLanguage("/repo/src/app.jsx")).toBe("javascript");
        expect(getRightEditorLanguage("/repo/config.json")).toBe("json");
        expect(getRightEditorLanguage("/repo/main.py")).toBe("python");
        expect(getRightEditorLanguage("/repo/main.go")).toBe("go");
        expect(getRightEditorLanguage("/repo/lib.rs")).toBe("rust");
        expect(getRightEditorLanguage("/repo/README.md")).toBe("markdown");
    });

    it("maps shell dotfiles by basename", () => {
        expect(getRightEditorLanguage("/Users/me/.zshrc")).toBe("shell");
        expect(getRightEditorLanguage("/Users/me/.bash_profile")).toBe("shell");
    });

    it("falls back to plaintext for unknown files", () => {
        expect(getRightEditorLanguage("/repo/data.unknownext")).toBe("plaintext");
        expect(getRightEditorLanguage("/repo/Makefile")).toBe("plaintext");
    });
});
