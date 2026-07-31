// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WorkspaceBootstrapPath = path.resolve(__dirname, "wave.ts");

describe("workspace AI config bootstrap", () => {
    it("starts loading ai.json before rendering the workspace", () => {
        const source = fs.readFileSync(WorkspaceBootstrapPath, "utf8");
        const initializeIndex = source.indexOf("initAIUserConfig();");
        const renderIndex = source.indexOf("workspaceRoot.render(");

        expect(source).toContain('import { initAIUserConfig } from "@/app/store/ai-user-config";');
        expect(initializeIndex).toBeGreaterThan(-1);
        expect(initializeIndex).toBeLessThan(renderIndex);
    });
});
