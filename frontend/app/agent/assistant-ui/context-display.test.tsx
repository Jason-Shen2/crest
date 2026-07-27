// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
    ContextDisplayRing,
    formatContextTokenCount,
    getContextUsagePercent,
    type CrestContextUsage,
} from "./context-display";

describe("ContextDisplayRing", () => {
    it("formats and clamps context usage percentages", () => {
        expect(formatContextTokenCount(999)).toBe("999");
        expect(formatContextTokenCount(128000)).toBe("128.0k");
        expect(formatContextTokenCount(1000000)).toBe("1.0M");
        expect(getContextUsagePercent(64000, 128000)).toBe(50);
        expect(getContextUsagePercent(256000, 128000)).toBe(100);
        expect(getContextUsagePercent(100, 0)).toBe(0);
    });

    it("renders a compact local context ring without the AI SDK adapter", () => {
        const usage: CrestContextUsage = {
            inputTokens: 72000,
            cachedInputTokens: 12000,
            outputTokens: 6000,
            totalTokens: 90000,
        };

        const html = renderToStaticMarkup(<ContextDisplayRing modelContextWindow={128000} usage={usage} />);

        expect(html).toContain('data-slot="context-display-trigger"');
        expect(html).toContain('aria-label="Context usage"');
        expect(html).toContain("70%");
        expect(html).toContain('width="22"');
        expect(html).toContain("aui-context-display-ring-trigger size-6");
        expect(html).toContain("stroke-amber-500");
        expect(html).not.toContain("react-ai-sdk");
    });
});
