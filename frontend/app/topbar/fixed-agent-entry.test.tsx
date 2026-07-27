// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FixedAgentEntry } from "./fixed-agent-entry";

afterEach(cleanup);

describe("FixedAgentEntry", () => {
    it("activates Agent independently from the left panel buttons", () => {
        const onActivate = vi.fn();
        render(<FixedAgentEntry active onActivate={onActivate} />);

        const entry = screen.getByRole("button", { name: "Agent" });
        expect(entry.getAttribute("aria-pressed")).toBe("true");
        expect(entry.className).toContain("h-7");
        expect(entry.className).toContain("rounded-md");
        expect(entry.className).toContain("bg-fg-overlay-2");
        fireEvent.click(entry);

        expect(onActivate).toHaveBeenCalledOnce();
    });
});
