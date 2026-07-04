// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { getFileBackedBlockLabel } from "./vtab-file-label";

function meta(value: Record<string, string>): MetaType {
    return value as MetaType;
}

describe("getFileBackedBlockLabel", () => {
    it("uses meta.file for codeeditor labels before file:path", () => {
        expect(
            getFileBackedBlockLabel(meta({
                view: "codeeditor",
                file: "/repo/src/editor.ts",
                "file:path": "/repo/src/stale-preview.ts",
            }))
        ).toEqual({
            path: "/repo/src/editor.ts",
            basename: "editor.ts",
            fallbackTitle: "Code editor",
        });
    });

    it("keeps preview labels backed by file:path", () => {
        expect(
            getFileBackedBlockLabel(meta({
                view: "preview",
                "file:path": "/repo/README.md",
            }))
        ).toEqual({
            path: "/repo/README.md",
            basename: "README.md",
            fallbackTitle: "Preview",
        });
    });

    it("does not treat unrelated views as file-backed", () => {
        expect(
            getFileBackedBlockLabel(meta({
                view: "web",
                file: "/repo/src/editor.ts",
                "file:path": "/repo/README.md",
            }))
        ).toBeNull();
    });
});
