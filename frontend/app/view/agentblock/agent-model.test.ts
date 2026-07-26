// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atom, getDefaultStore } from "jotai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/term/render/agent-surface", () => ({ WorkspaceAgentSurface: () => null }));
vi.mock("@/app/xterm/xterm-session", () => ({ disposeSession: vi.fn() }));
vi.mock("@/app/fileexplorer/file-explorer-atoms", () => ({ workspaceDirAtom: null }));

const cmdRowsMock = vi.hoisted(() => ({
    attachCmdRows: vi.fn(),
    detachCmdRows: vi.fn(),
}));
vi.mock("@/app/xterm/cmdblock-rows", () => ({
    attachCmdRows: cmdRowsMock.attachCmdRows,
    detachCmdRows: cmdRowsMock.detachCmdRows,
    recentCommandsAtom: () => atom<string[]>([]),
}));

import { AgentViewModel } from "./agent-model";

describe("AgentViewModel", () => {
    it("keeps the terminal naming surface while using the agent icon", () => {
        const model = new AgentViewModel({ blockId: "b1" } as ViewModelInitType);
        const store = getDefaultStore();

        expect(store.get(model.viewName)).toBe("");
        expect(store.get(model.viewIcon)).toBe("sparkles");
    });

    it("attaches the cmd-rows store for its block and detaches on dispose", () => {
        cmdRowsMock.attachCmdRows.mockClear();
        cmdRowsMock.detachCmdRows.mockClear();

        const model = new AgentViewModel({ blockId: "b-rows" } as ViewModelInitType);
        expect(cmdRowsMock.attachCmdRows).toHaveBeenCalledWith("b-rows");
        expect(cmdRowsMock.detachCmdRows).not.toHaveBeenCalled();

        model.dispose();
        expect(cmdRowsMock.detachCmdRows).toHaveBeenCalledWith("b-rows");
    });

    it("hosts the workspace Agent surface directly, without the old terminal view", () => {
        const source = readFileSync(join(process.cwd(), "frontend/app/view/agentblock/agent-model.tsx"), "utf8");

        expect(source).not.toContain("react-hooks/rules-of-hooks");
        expect(source).toContain("<WorkspaceAgentSurface");
        expect(source).not.toContain("render/terminal-view");
        expect(source).not.toContain("AgentPaneSlot");
    });
});
