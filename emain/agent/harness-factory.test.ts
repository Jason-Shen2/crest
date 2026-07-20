// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { Model } from "../ai";
import { createExtensionLifecycleHost } from "./extensions/lifecycle";
import { buildAgentHarnessHost } from "./harness-factory";
import { InMemorySessionRepo } from "./harness/session/memory-repo";
import type { ToolCallEvent } from "./harness/types";
import type { ToolCallHook } from "./permissions";

const extensionMocks = vi.hoisted(() => {
    const cleanup = vi.fn();
    const extensionTool = {
        name: "shared_tool",
        label: "Extension Tool",
        description: "extension",
        parameters: { type: "object", properties: {} },
        promptSnippet: "extension snippet",
        execute: vi.fn(),
    };
    return {
        bindExtensionRuntime: vi.fn(),
        cleanup,
        createExtensionContext: vi.fn(() => ({ cwd: "/work" })),
        extensionTool,
        mergeBaseAndExtensionTools: vi.fn((baseTools: any[]) => {
            const baseToolNames = new Set(baseTools.map((tool) => tool.name));
            const extensionTools = [extensionTool].filter((tool) => !baseToolNames.has(tool.name));
            return [...baseTools, ...extensionTools];
        }),
        wireExtensionHooks: vi.fn(() => cleanup),
    };
});

vi.mock("./extensions", () => ({
    bindExtensionRuntime: extensionMocks.bindExtensionRuntime,
    createExtensionContext: extensionMocks.createExtensionContext,
    mergeBaseAndExtensionTools: extensionMocks.mergeBaseAndExtensionTools,
    wireExtensionHooks: extensionMocks.wireExtensionHooks,
}));

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
    it("exposes the current cwd after an execution-context update", async () => {
        const session = await new InMemorySessionRepo().create({});
        const host = buildAgentHarnessHost({
            session,
            model: fakeModel(),
            promptInputs: { cwd: "/first" },
        });

        expect(host.getCwd()).toBe("/first");
        host.update({ cwd: "/second" });
        expect(host.getCwd()).toBe("/second");
    });

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

    it("registers extension hook cleanup with the lifecycle owner id", async () => {
        extensionMocks.cleanup.mockClear();
        extensionMocks.wireExtensionHooks.mockClear();
        const session = await new InMemorySessionRepo().create();
        const lifecycleHost = createExtensionLifecycleHost();
        const registerDispose = vi.spyOn(lifecycleHost, "registerDispose");

        buildAgentHarnessHost({
            session,
            model: fakeModel(),
            promptInputs: { cwd: "/work" },
            extensions: [{ path: "<test>" } as any],
            extensionLifecycleOwnerId: "session-1",
            extensionLifecycleHost: lifecycleHost,
        });
        await lifecycleHost.disposeAll();

        expect(extensionMocks.wireExtensionHooks).toHaveBeenCalledTimes(1);
        expect(registerDispose).toHaveBeenCalledWith("session-1", extensionMocks.cleanup);
        expect(extensionMocks.cleanup).toHaveBeenCalledTimes(1);
    });

    it("keeps base tools when extension tools use the same name", async () => {
        const session = await new InMemorySessionRepo().create();
        const host = buildAgentHarnessHost({
            session,
            model: fakeModel(),
            promptInputs: { cwd: "/work" },
            tools: [
                {
                    name: "shared_tool",
                    label: "Base Tool",
                    description: "base",
                    parameters: { type: "object", properties: {} },
                    promptSnippet: "base snippet",
                    execute: vi.fn(),
                },
            ],
            extensions: [{ path: "<test>" } as any],
        });

        const systemPrompt = await host.harness.buildSystemPrompt();

        expect(systemPrompt).toContain("base snippet");
        expect(systemPrompt).not.toContain("extension snippet");
    });
});
