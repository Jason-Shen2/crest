// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("terminal view selector implementation", () => {
    it("uses the shared cmdblock SessionSelector instead of the legacy term popover", () => {
        const source = readFileSync(join(process.cwd(), "frontend/app/term/render/terminal-view.tsx"), "utf8");

        expect(source).toContain('import { SessionSelector } from "@/app/view/cmdblock/session-selector";');
        expect(source).toContain("<SessionSelector");
        expect(source).not.toContain('import { AgentSelectorPopover } from "./agent-selector-popover";');
        expect(source).not.toContain("<AgentSelectorPopover");
    });

    it("removes the legacy term selector implementation", () => {
        expect(existsSync(join(process.cwd(), "frontend/app/term/render/agent-selector-popover.tsx"))).toBe(false);
        expect(existsSync(join(process.cwd(), "frontend/app/term/render/agent-selector-popover.test.tsx"))).toBe(false);
    });
});
