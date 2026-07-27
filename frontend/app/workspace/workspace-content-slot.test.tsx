// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceContentSlot } from "./workspace-content-slot";

afterEach(() => {
    cleanup();
});

describe("WorkspaceContentSlot", () => {
    it("preserves child identity when activation attributes change", () => {
        const view = render(
            <WorkspaceContentSlot active={true} testId="workspace-slot">
                <div data-testid="slot-child">content</div>
            </WorkspaceContentSlot>
        );
        const activeSlot = screen.getByTestId("workspace-slot");
        const child = screen.getByTestId("slot-child");

        expect(activeSlot.getAttribute("aria-hidden")).toBe("false");
        expect(activeSlot.hasAttribute("inert")).toBe(false);
        expect(activeSlot.style.visibility).toBe("visible");
        expect(activeSlot.style.pointerEvents).toBe("auto");

        view.rerender(
            <WorkspaceContentSlot active={false} testId="workspace-slot">
                <div data-testid="slot-child">content</div>
            </WorkspaceContentSlot>
        );
        const inactiveSlot = screen.getByTestId("workspace-slot");

        expect(inactiveSlot).toBe(activeSlot);
        expect(screen.getByTestId("slot-child")).toBe(child);
        expect(inactiveSlot.getAttribute("aria-hidden")).toBe("true");
        expect(inactiveSlot.hasAttribute("inert")).toBe(true);
        expect(inactiveSlot.style.visibility).toBe("hidden");
        expect(inactiveSlot.style.pointerEvents).toBe("none");
    });
});
