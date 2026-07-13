// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("FileExplorer", () => {
    test("drives tree scrollbar visibility from scroll activity instead of hover", () => {
        const source = readFileSync(join(process.cwd(), "frontend/app/fileexplorer/file-explorer.tsx"), "utf8");

        expect(source).toContain("file-explorer-scroll");
        expect(source).toContain("data-scrolling");
        expect(source).toContain("onScroll");
    });
});
