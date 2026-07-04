// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { middleEllipsis } from "./util";

describe("middleEllipsis", () => {
    it("returns empty string for empty input", () => {
        expect(middleEllipsis("", 10)).toBe("");
    });

    it("returns the original value when shorter than maxChars", () => {
        expect(middleEllipsis("short", 10)).toBe("short");
    });

    it("returns the original value when maxChars is too small to ellipsize", () => {
        // maxChars < 6 means we can't fit the ellipsis + 2 segments meaningfully
        expect(middleEllipsis("a long string here", 5)).toBe("a long string here");
    });

    it("truncates with ellipsis when longer than maxChars", () => {
        const result = middleEllipsis("frontend/app/codereview/git-panel.tsx", 20);
        expect(result).toContain("…");
        expect(result.length).toBeLessThanOrEqual(20);
        // Head segment preserved (leading module)
        expect(result).toMatch(/^frontend\//);
        // Tail segment preserved (file name visible at end)
        expect(result).toMatch(/tsx$/);
    });

    it("keeps at least 2 chars on each side", () => {
        const result = middleEllipsis("abcdefghijklmnop", 10);
        // keep = floor((10 - 1) / 2) = 4 → "abcd…mnop" (9 chars, not 10)
        expect(result).toBe("abcd…mnop");
    });
});