// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThreadLoading } from "./thread-loading";

describe("ThreadLoading", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it("delays the loading status and renders deterministic turn skeletons", () => {
        render(<ThreadLoading />);

        expect(screen.queryByRole("status")).toBeNull();
        act(() => {
            vi.advanceTimersByTime(179);
        });
        expect(screen.queryByRole("status")).toBeNull();

        act(() => {
            vi.advanceTimersByTime(1);
        });
        const status = screen.getByRole("status");
        expect(status.getAttribute("aria-live")).toBe("polite");
        expect(status.textContent).toContain("Loading conversation…");
        expect(status.getAttribute("data-slot")).toBe("aui_thread-loading");
        expect(document.querySelectorAll('[data-slot="aui_thread-loading-turn"]')).toHaveLength(2);
        expect(document.querySelectorAll('[data-slot="aui_thread-loading-user"]')).toHaveLength(2);
        expect(document.querySelectorAll('[data-slot="aui_thread-loading-assistant"]')).toHaveLength(2);
        expect(document.querySelector('[data-slot="aui_thread-loading-skeletons"]')?.getAttribute("aria-hidden")).toBe(
            "true"
        );
    });

    it("announces a long conversation after the total wait", () => {
        render(<ThreadLoading />);

        act(() => {
            vi.advanceTimersByTime(3000);
        });

        expect(screen.getByRole("status").textContent).toContain("Loading a long conversation…");
        expect(screen.queryByText("Loading conversation…")).toBeNull();
    });

    it("clears both timers when unmounted before becoming visible", () => {
        const { unmount } = render(<ThreadLoading />);
        expect(vi.getTimerCount()).toBe(2);

        unmount();

        expect(vi.getTimerCount()).toBe(0);
    });
});
