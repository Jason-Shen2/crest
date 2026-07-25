// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TestState = vi.hoisted(() => ({ configDir: "" }));

vi.mock("../emain-platform", () => ({
    getWaveConfigDir: () => TestState.configDir,
}));

import { parseContextReferenceConfig } from "../agent/context/validation";
import { readAIUserConfig, writeAIUserConfig } from "./user-config";

function config(overrides: Record<string, unknown> = {}) {
    return {
        providers: { test: { token: "secret" } },
        default: { provider: "test", model: "model" },
        ...overrides,
    };
}

describe("AI user config context references", () => {
    beforeEach(async () => {
        TestState.configDir = await fs.mkdtemp(path.join(os.tmpdir(), "crest-ai-config-"));
    });

    afterEach(async () => {
        await fs.rm(TestState.configDir, { recursive: true, force: true });
    });

    it("accepts an absent context_references field and defaults runtime behavior", async () => {
        await writeAIUserConfig(config());

        const result = await readAIUserConfig();

        expect(result.status).toBe("ok");
        expect(result.config).not.toHaveProperty("context_references");
        expect(parseContextReferenceConfig(result.config)).toEqual({ enabled: true });
    });

    it("preserves file values while runtime parsing defaults and clamps them", async () => {
        const input = config({
            context_references: {
                max_tokens: 200_000,
            },
            future_field: { version: 2 },
        });

        await writeAIUserConfig(input);
        const result = await readAIUserConfig();

        expect(result).toEqual({ status: "ok", config: input });
        expect(parseContextReferenceConfig(result.config)).toEqual({
            enabled: true,
            maxTokens: 128_000,
        });
        expect(JSON.parse(await fs.readFile(path.join(TestState.configDir, "ai.json"), "utf8"))).toEqual(input);
    });

    it("clamps a present negative max_tokens only at runtime", async () => {
        const input = config({ context_references: { enabled: false, max_tokens: -10 } });

        await writeAIUserConfig(input);
        const result = await readAIUserConfig();

        expect(result).toEqual({ status: "ok", config: input });
        expect(parseContextReferenceConfig(result.config)).toEqual({
            enabled: false,
            maxTokens: 0,
        });
    });

    it.each([
        [{ context_references: { max_tokens: Number.NaN } }, /context_references\.max_tokens/],
        [{ context_references: { max_tokens: Number.POSITIVE_INFINITY } }, /context_references\.max_tokens/],
    ])("rejects invalid context reference config on write", async (overrides, expected) => {
        await expect(writeAIUserConfig(config(overrides))).rejects.toThrow(expected);
    });

    it("reports invalid context reference config read from disk as malformed", async () => {
        await fs.writeFile(
            path.join(TestState.configDir, "ai.json"),
            JSON.stringify(config({ context_references: { max_tokens: null } }))
        );

        await expect(readAIUserConfig()).resolves.toMatchObject({
            status: "malformed",
            error: expect.stringMatching(/context_references\.max_tokens/),
        });
    });
});
