// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function source(path: string): string {
    return readFileSync(join(process.cwd(), path), "utf8");
}

describe("workspace content isolation boundaries", () => {
    test("keeps navigation visibility out of the Agent root", () => {
        const agentContent = source("frontend/app/agent/agent-content.tsx");

        expect(agentContent).not.toMatch(/\bvisible\s*:\s*boolean/);
        expect(agentContent).not.toMatch(/\bvisible=\{/);
    });

    test("does not use imperative or deferred navigation workarounds", () => {
        const guardedFiles = [
            "frontend/app/workspace/workspace-content-slot.tsx",
            "frontend/app/workspace/workspace-agent-content-slot.tsx",
            "frontend/app/workspace/top-tab-content-deck.tsx",
            "frontend/app/workspace/workspace-main-content.tsx",
        ];
        const forbidden = /\b(querySelector|requestAnimationFrame|setTimeout|useDeferredValue|startTransition)\b/;

        for (const path of guardedFiles) {
            expect(source(path), path).not.toMatch(forbidden);
        }
    });

    test("keeps cold File loading separate from Monaco mounting", () => {
        const fileSlot = source("frontend/app/workspace/workspace-file-content-slot.tsx");

        expect(fileSlot).toContain('status === "ready" || status === "error"');
        expect(fileSlot).toContain("<LoadingFileSurface");
        expect(fileSlot).not.toMatch(/\b(setTimeout|requestAnimationFrame|useDeferredValue|startTransition)\b/);
    });

    test("keeps Top Tab chrome outside the central coordinator", () => {
        const workspaceMainContent = source("frontend/app/workspace/workspace-main-content.tsx");

        expect(workspaceMainContent).not.toContain("TopTabStrip");
    });

    test("keeps Agent activity out of React render state", () => {
        const activity = source("frontend/app/agent/agent-surface-activity.tsx");

        expect(activity).not.toMatch(/createContext\(\s*(true|false)\s*\)/);
        expect(activity).not.toContain("useSyncExternalStore");
    });

    test("keeps the changing activity boolean out of the Agent Provider", () => {
        const agentSlot = source("frontend/app/workspace/workspace-agent-content-slot.tsx");

        expect(agentSlot).not.toContain("AgentSurfaceActivityProvider active=");
        expect(agentSlot).toContain("AgentSurfaceActivityProvider controller=");
    });

    test("keeps PTY activity out of command-card render state", () => {
        const commandCard = source("frontend/app/agent/agent-command-card.tsx");

        expect(commandCard).not.toContain("useAgentSurfaceActive");
        expect(commandCard).toContain("useAgentSurfaceActivityController");
    });

    test("keeps Agent session activity out of hook render inputs", () => {
        const chatHost = source("frontend/app/agent/agent-chat-host.tsx");
        const piChat = source("frontend/app/store/use-pi-chat.ts");

        expect(chatHost).not.toContain("useAgentSurfaceActive");
        expect(piChat).not.toMatch(/\bvisible\s*:\s*boolean/);
        expect(piChat).toContain("activity?: UsePiChatActivity");
    });
});
