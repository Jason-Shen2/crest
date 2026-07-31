// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
    ContextDisplayRing,
    formatContextTokenCount,
    getContextUsagePercent,
    type CrestContextDisplayValue,
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
        const value: CrestContextDisplayValue = {
            effectiveInputTokens: 72_000,
            inputCapacity: 128_000,
            accuracy: "estimated",
            lifecycle: "ready",
        };

        const html = renderToStaticMarkup(<ContextDisplayRing value={value} />);

        expect(html).toContain('data-slot="context-display-trigger"');
        expect(html).toContain('aria-label="Open Context Inspector, 56 percent used"');
        expect(html).toContain("56%");
        expect(html).toContain('width="22"');
        expect(html).toContain("aui-context-display-ring-trigger size-6");
        expect(html).toContain("stroke-emerald-500");
        expect(html).not.toContain("react-ai-sdk");
    });

    it("opens the inspector and remains visible before the first prompt", () => {
        const onOpen = vi.fn();
        render(
            <ContextDisplayRing
                value={{
                    effectiveInputTokens: 0,
                    inputCapacity: 100_000,
                    accuracy: "exact",
                    lifecycle: "ready",
                }}
                onOpen={onOpen}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Open Context Inspector, 0 percent used" }));
        expect(onOpen).toHaveBeenCalledOnce();
    });
});
