// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const FrontendRoot = path.resolve(__dirname, "../..");

const WorkspaceAgentFiles = [
    "app/agent/agent-content.tsx",
    "app/agent/agent-sessions-panel.tsx",
    "app/workspace/workspace-agent-model.ts",
    "app/workspace/workspace-app.tsx",
    "app/workspace/workspace-left-panel.tsx",
    "app/workspace/workspace-main-content.tsx",
    "app/workspace/workspace-right-panel-host.tsx",
];

const ForbiddenAgentBoundaryPatterns = [
    "TerminalModel",
    "terminal-model",
    "view/" + "agent" + "block",
    "pendingResume" + "SessionAtom",
    "open" + "AgentTab",
    "layout:" + "agenttabid",
    "agent" + "TabIdAtom",
    "staticTabId",
    "view: \"agent\"",
    "view:" + "'agent'",
    "view === \"agent\"",
    "view === " + "'agent'",
];

describe("workspace Agent boundary", () => {
    it("keeps workspace Agent ownership independent from legacy Terminal/Tab internals", () => {
        for (const relativePath of WorkspaceAgentFiles) {
            const filePath = path.join(FrontendRoot, relativePath);
            expect(fs.existsSync(filePath), `${relativePath} exists`).toBe(true);
            const source = fs.readFileSync(filePath, "utf8");

            for (const forbidden of ForbiddenAgentBoundaryPatterns) {
                expect(source, `${relativePath} contains ${forbidden}`).not.toContain(forbidden);
            }
        }
    });
});
