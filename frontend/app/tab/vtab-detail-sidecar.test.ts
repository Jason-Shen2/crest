// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { resolveVtabDetailHeaderTitle } from "./vtab-detail-sidecar";

describe("resolveVtabDetailHeaderTitle", () => {
    it("uses a file label for an auto-named codeeditor tab in tabs mode", () => {
        const title = resolveVtabDetailHeaderTitle({
            isPaneMode: false,
            isAutoNamed: true,
            tabName: "T1",
            cwdShort: "/repo",
            fileLabel: {
                path: "/repo/src/editor.ts",
                basename: "editor.ts",
                fallbackTitle: "Code editor",
            },
            view: "codeeditor",
            webUrl: "",
        });

        expect(title).toBe("editor.ts");
    });

    it("uses cwd for agent panes instead of showing the raw view name", () => {
        const title = resolveVtabDetailHeaderTitle({
            isPaneMode: true,
            isAutoNamed: true,
            tabName: "T1",
            cwdShort: "/repo",
            fileLabel: null,
            view: "agent",
            webUrl: "",
        });

        expect(title).toBe("/repo");
    });

    it("falls back to Terminal for agent panes without cwd", () => {
        const title = resolveVtabDetailHeaderTitle({
            isPaneMode: true,
            isAutoNamed: true,
            tabName: "T1",
            cwdShort: "",
            fileLabel: null,
            view: "agent",
            webUrl: "",
        });

        expect(title).toBe("Terminal");
    });
});
