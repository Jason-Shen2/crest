// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { findProvider } from "./ai-catalog";

describe("AI catalog", () => {
    it("registers minimax as an Anthropic-compatible built-in provider", () => {
        const provider = findProvider("minimax");

        expect(provider).toMatchObject({
            id: "minimax",
            defaultEndpoint: "https://api.minimax.io/anthropic",
            defaultApiType: "anthropic-messages",
            tokenSecretName: "MINIMAX_API_KEY",
        });
        expect(provider?.models.map((model) => model.id)).toContain("MiniMax-M2.7");
    });
});
