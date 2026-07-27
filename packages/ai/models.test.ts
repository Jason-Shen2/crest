// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getModels, getSupportedThinkingLevels } from "./models";

describe("GitHub Copilot model catalog", () => {
    it("exposes Claude Opus 5 through the Anthropic Messages API", () => {
        const model = getModels("github-copilot").find((candidate) => candidate.id === "claude-opus-5");

        expect(model).toMatchObject({
            api: "anthropic-messages",
            provider: "github-copilot",
            contextWindow: 1_000_000,
            compat: { forceAdaptiveThinking: true },
            thinkingLevelMap: { minimal: "low", xhigh: "xhigh" },
        });
        expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
    });
});
