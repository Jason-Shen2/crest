// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { Model } from "../ai";
import { InMemorySessionRepo } from "./harness/session/memory-repo";
import type { ToolCallEvent } from "./harness/types";
import type { ToolCallHook } from "./permissions";
import { buildAgentHarnessHost } from "./harness-factory";

function fakeModel(): Model<any> {
    return {
        id: "model-1",
        name: "Model 1",
        api: "openai-completions",
        provider: "openai",
        baseUrl: "http://localhost",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000,
        maxTokens: 1000,
    };
}

describe("AgentHarnessHost", () => {
    it("updates auth and tool hooks without rebuilding the Harness", async () => {
        const session = await new InMemorySessionRepo().create({});
        const model = fakeModel();
        const toolEvent: ToolCallEvent = {
            type: "tool_call",
            toolCallId: "call-1",
            toolName: "bash",
            input: {},
        };
        const firstAuth = vi.fn(async () => ({ apiKey: "first" }));
        const secondAuth = vi.fn(async () => ({ apiKey: "second" }));
        const firstHook: ToolCallHook = vi.fn(async () => undefined);
        const secondHook: ToolCallHook = vi.fn(async () => ({ block: true, reason: "blocked" }));
        const host = buildAgentHarnessHost({
            session,
            model,
            promptInputs: { cwd: "/a" },
            getApiKeyAndHeaders: firstAuth,
            toolCallHook: firstHook,
        });

        host.setAuthResolver(secondAuth);
        host.setToolCallHook(secondHook);

        await expect(host.resolveAuth(model)).resolves.toEqual({ apiKey: "second" });
        await expect(host.runToolCallHook(toolEvent)).resolves.toEqual({ block: true, reason: "blocked" });
        expect(firstAuth).not.toHaveBeenCalled();
        expect(firstHook).not.toHaveBeenCalled();
    });
});
