// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    formatContextAccuracy,
    formatContextLifecycle,
    formatContextPercent,
    formatContextTokens,
} from "./context-format";

describe("context inspector formatting", () => {
    it("formats counts, percentages, lifecycle, and accuracy without inventing unavailable values", () => {
        expect(formatContextTokens(128_000)).toBe("128.0k");
        expect(formatContextTokens(undefined)).toBe("Unavailable");
        expect(formatContextPercent(25, 100)).toBe("25%");
        expect(formatContextLifecycle("waiting_for_tool")).toBe("Waiting for tool result");
        expect(formatContextAccuracy("exact")).toBe("Exact");
        expect(formatContextAccuracy("unavailable")).toBe("Token count unavailable");
    });
});
