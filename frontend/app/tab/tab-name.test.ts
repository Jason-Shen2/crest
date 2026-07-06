// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { basename, deriveBlockDisplayName, isTabAutoNamed } from "./tab-name";

function makeBlock(meta: Record<string, unknown>): Block {
    return { oid: "b1", version: 1, meta } as unknown as Block;
}

function makeTab(name: string, meta?: Record<string, unknown>): Tab {
    return { oid: "t1", version: 1, name, meta } as unknown as Tab;
}

describe("isTabAutoNamed", () => {
    it("is true when the tab carries the tab:autoname flag", () => {
        expect(isTabAutoNamed(makeTab("myrepo", { "tab:autoname": true }))).toBe(true);
    });

    it("does not infer auto-name state from T<number>", () => {
        expect(isTabAutoNamed(makeTab("T3"))).toBe(false);
    });

    it("is false for user-named tabs", () => {
        expect(isTabAutoNamed(makeTab("My Tab"))).toBe(false);
        expect(isTabAutoNamed(makeTab("main.ts", {}))).toBe(false);
    });

    it("is false for null/undefined tabs", () => {
        expect(isTabAutoNamed(null)).toBe(false);
        expect(isTabAutoNamed(undefined)).toBe(false);
    });
});

describe("basename", () => {
    it("returns the last path segment", () => {
        expect(basename("/repo/src/main.ts")).toBe("main.ts");
        expect(basename("C:\\repo\\main.ts")).toBe("main.ts");
        expect(basename("main.ts")).toBe("main.ts");
    });

    it("strips a trailing slash", () => {
        expect(basename("/repo/src/")).toBe("src");
    });
});

describe("deriveBlockDisplayName", () => {
    it("uses the file basename for editor blocks", () => {
        expect(deriveBlockDisplayName(makeBlock({ view: "codeeditor", file: "/repo/src/main.ts" }))).toBe("main.ts");
    });

    it("uses the git diff file basename and mode for gitdiff blocks", () => {
        expect(
            deriveBlockDisplayName(
                makeBlock({ view: "gitdiff", "gitdiff:path": "/repo/src/source-control-panel.tsx", "gitdiff:mode": "-" })
            )
        ).toBe("source-control-panel.tsx (-)");
    });

    it("uses the file basename for preview blocks", () => {
        expect(deriveBlockDisplayName(makeBlock({ view: "preview", file: "/repo/docs/readme.md" }))).toBe("readme.md");
    });

    it("uses the cwd directory name for terminal blocks", () => {
        expect(deriveBlockDisplayName(makeBlock({ view: "term", "cmd:cwd": "/repo/src" }))).toBe("src");
        expect(deriveBlockDisplayName(makeBlock({ view: "termblocks", "cmd:cwd": "/repo/src" }))).toBe("src");
    });

    it("returns empty for a terminal that has not reported a cwd yet", () => {
        expect(deriveBlockDisplayName(makeBlock({ view: "term" }))).toBe("");
    });

    it("uses the url for web blocks", () => {
        expect(deriveBlockDisplayName(makeBlock({ view: "web", url: "https://example.com" }))).toBe(
            "https://example.com"
        );
    });

    it("falls back to the human-readable view name for other views", () => {
        expect(deriveBlockDisplayName(makeBlock({ view: "help" }))).toBe("Help");
        expect(deriveBlockDisplayName(makeBlock({ view: "processviewer" }))).toBe("Processes");
    });

    it("returns empty when there is no block or view", () => {
        expect(deriveBlockDisplayName(null)).toBe("");
        expect(deriveBlockDisplayName(makeBlock({}))).toBe("");
    });
});
