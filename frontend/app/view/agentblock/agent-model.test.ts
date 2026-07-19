// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getDefaultStore } from "jotai";
import { describe, expect, it, vi } from "vitest";
import { AgentViewModel } from "./agent-model";

vi.mock("@/app/term/render/terminal-view", () => ({ TerminalView: () => null }));
vi.mock("@/app/term/render/agent-surface", () => ({ WorkspaceAgentSurface: () => null }));

describe("AgentViewModel", () => {
    it("keeps the terminal naming surface while using the agent icon", () => {
        const model = new AgentViewModel({ blockId: "b1" } as ViewModelInitType);
        const store = getDefaultStore();

        expect(store.get(model.viewName)).toBe("");
        expect(store.get(model.viewIcon)).toBe("sparkles");
    });

    it("passes the workspace Agent surface directly to TerminalView", () => {
        const source = readFileSync(join(process.cwd(), "frontend/app/view/agentblock/agent-model.tsx"), "utf8");

        expect(source).not.toContain("react-hooks/rules-of-hooks");
        expect(source).toContain("agentSurfaceComponent={WorkspaceAgentSurface}");
        expect(source).not.toContain("AgentPaneSlot");
    });
});
