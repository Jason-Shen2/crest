// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedoDock } from "./redo-dock";

function makeRedo(overrides: Partial<AgentRedoView> = {}): AgentRedoView {
    return {
        operationId: "operation-1",
        targetPrompt: "Restore the original implementation",
        messageCount: 3,
        fileCount: 2,
        files: [
            {
                path: "src/new.ts",
                operation: "write",
                additions: 4,
                deletions: 1,
                coverage: "covered",
                conflict: "none",
            },
            {
                path: "src/removed.ts",
                operation: "delete",
                coverage: "covered",
                conflict: "none",
            },
        ],
        ...overrides,
    };
}

afterEach(cleanup);

describe("RedoDock", () => {
    it("keeps the authoritative redo summary and action visible while details are collapsed", () => {
        const onRedo = vi.fn();
        render(<RedoDock redo={makeRedo()} busy={false} onRedo={onRedo} />);

        expect(screen.getByText("Reverted 3 messages · 2 files")).not.toBeNull();
        expect(screen.getByRole("button", { name: "Redo" })).not.toBeNull();
        expect(screen.queryByText("Restore the original implementation")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Redo" }));
        expect(onRedo).toHaveBeenCalledOnce();
    });

    it("expands durable prompt, operation, and file summaries without hiding Redo", () => {
        render(<RedoDock redo={makeRedo()} busy={false} onRedo={vi.fn()} />);

        fireEvent.click(screen.getByRole("button", { name: "Show reverted details" }));

        expect(screen.getByText("Restore the original implementation")).not.toBeNull();
        expect(screen.getByText("Operation operation-1")).not.toBeNull();
        expect(screen.getByText("src/new.ts")).not.toBeNull();
        expect(screen.getByText("write")).not.toBeNull();
        expect(screen.getByText("+4")).not.toBeNull();
        expect(screen.getByText("-1")).not.toBeNull();
        expect(screen.getByRole("button", { name: "Redo" })).not.toBeNull();
        const toggle = screen.getByRole("button", { name: "Hide reverted details" });
        const details = screen.getByRole("region", { name: "Reverted operation details" });
        expect(toggle.getAttribute("aria-controls")).toBe(details.id);
        expect(details.className).toMatch(/max-h-/);
        expect(details.className).toContain("overflow-y-auto");
    });

    it.each(["busy", "frozen", "applying"])("prevents duplicate redo while the controller is %s", () => {
        const onRedo = vi.fn();
        render(<RedoDock redo={makeRedo()} busy onRedo={onRedo} />);

        const button = screen.getByRole("button", { name: "Redo" });
        expect(button.hasAttribute("disabled")).toBe(true);
        fireEvent.click(button);
        expect(onRedo).not.toHaveBeenCalled();
    });
});
