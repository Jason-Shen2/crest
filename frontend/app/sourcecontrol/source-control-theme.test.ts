// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ThemeOwnedHexColors = [
    "#09090b",
    "#1a1410",
    "#1f2023",
    "#202124",
    "#27272a",
    "#2d2e31",
    "#34343a",
    "#38393d",
    "#3f3f46",
    "#52525b",
    "#71717a",
    "#92724F",
    "#a0805c",
    "#a1a1aa",
    "#f4f4f5",
];

function readSource(fileName: string): string {
    return readFileSync(new URL(fileName, import.meta.url), "utf8");
}

function expectThemeTokens(source: string): void {
    for (const color of ThemeOwnedHexColors) {
        expect(source).not.toContain(color);
    }
    expect(source).not.toMatch(/\btext-(muted|secondary)(?=[\s"/])/);
}

describe("source control theme usage", () => {
    it("uses theme tokens in the source control changes panel", () => {
        expectThemeTokens(readSource("./source-control-panel.tsx"));
    });

    it("uses theme tokens in the commit graph panel", () => {
        expectThemeTokens(readSource("./commit-graph-panel.tsx"));
    });
});
