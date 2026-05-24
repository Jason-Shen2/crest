// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import type { ToolCallEvent } from "./harness/types";
import { buildPermissionsHook, isBenchMode } from "./permissions";

function fakeToolCall(toolName: string): ToolCallEvent {
    return {
        type: "tool_call",
        toolCallId: "tc-1",
        toolName,
        input: {},
    };
}

describe("buildPermissionsHook", () => {
    it("allows every call when allowAll is true (default)", async () => {
        const hook = buildPermissionsHook();
        expect(await hook(fakeToolCall("anything"))).toBeUndefined();
        expect(await hook(fakeToolCall("rm-rf"))).toBeUndefined();
    });

    it("allows every call when allowAll is explicitly true", async () => {
        const hook = buildPermissionsHook({ allowAll: true, allowedTools: ["only_this"] });
        // allowAll wins; allowedTools is ignored.
        expect(await hook(fakeToolCall("not_listed"))).toBeUndefined();
    });

    it("enforces the allowlist when allowAll is false", async () => {
        const hook = buildPermissionsHook({
            allowAll: false,
            allowedTools: ["read", "ls"],
        });
        expect(await hook(fakeToolCall("read"))).toBeUndefined();
        expect(await hook(fakeToolCall("ls"))).toBeUndefined();
        const blocked = await hook(fakeToolCall("bash"));
        expect(blocked).toEqual({
            block: true,
            reason: expect.stringContaining("bash"),
        });
    });

    it("blocks all tools when allowAll is false and allowedTools is empty/missing", async () => {
        const hook = buildPermissionsHook({ allowAll: false });
        const result = await hook(fakeToolCall("read"));
        expect(result?.block).toBe(true);
    });

    it("includes the tool name in the block reason for actionable errors", async () => {
        const hook = buildPermissionsHook({ allowAll: false, allowedTools: [] });
        const result = await hook(fakeToolCall("custom_tool"));
        expect(result?.reason).toContain('"custom_tool"');
    });
});

describe("isBenchMode", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it("returns true when CREST_AGENT_BENCH=1", () => {
        process.env.CREST_AGENT_BENCH = "1";
        expect(isBenchMode()).toBe(true);
    });

    it("returns false when CREST_AGENT_BENCH is unset", () => {
        delete process.env.CREST_AGENT_BENCH;
        expect(isBenchMode()).toBe(false);
    });

    it("returns false when CREST_AGENT_BENCH is anything other than '1'", () => {
        process.env.CREST_AGENT_BENCH = "true";
        expect(isBenchMode()).toBe(false);
        process.env.CREST_AGENT_BENCH = "yes";
        expect(isBenchMode()).toBe(false);
        process.env.CREST_AGENT_BENCH = "";
        expect(isBenchMode()).toBe(false);
    });
});
