// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function readBlock(source: string, selector: string): string {
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = source.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
    return match?.[1] ?? "";
}

describe("global scrollbar styling", () => {
    test("keeps scrollbars hidden without relying on sticky hover state", () => {
        const source = readFileSync(join(process.cwd(), "frontend/app/app.scss"), "utf8");
        const thumbBlock = readBlock(source, "*::-webkit-scrollbar-thumb");

        expect(thumbBlock).toContain("background-color: transparent;");
        expect(source).not.toMatch(/^\*:hover::-webkit-scrollbar-thumb/m);
        expect(source).not.toMatch(/^\*:active::-webkit-scrollbar-thumb/m);
    });

    test("lets the file explorer show its scrollbar only while scrolling", () => {
        const source = readFileSync(join(process.cwd(), "frontend/app/app.scss"), "utf8");

        expect(source).toContain(".file-explorer-scroll:not([data-scrolling=\"true\"])::-webkit-scrollbar-thumb");
        expect(source).toContain(".file-explorer-scroll[data-scrolling=\"true\"]::-webkit-scrollbar-thumb");
        expect(source).toContain("background-color: var(--scrollbar-thumb-color);");
    });
});
