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
});
