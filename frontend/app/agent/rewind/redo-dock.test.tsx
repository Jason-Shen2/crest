// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedoDock } from "./redo-dock";

const getFileIconMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/fileexplorer/file-icon", () => ({
    getFileIcon: getFileIconMock,
}));

function TestFileIcon(props: { className?: string; size?: number }) {
    return <svg data-testid="redo-file-icon" className={props.className} data-size={props.size} />;
}

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

beforeEach(() => {
    getFileIconMock.mockReset();
    getFileIconMock.mockReturnValue(TestFileIcon);
});

describe("RedoDock", () => {
    it("keeps the reverted status, summary, primary action, and separate toggle visible on a neutral shell", () => {
        const onRedo = vi.fn();
        render(<RedoDock redo={makeRedo()} busy={false} onRedo={onRedo} />);

        const dock = screen.getByRole("region", { name: "Reverted workspace changes" });
        expect(dock.className).toContain("border-border");
        expect(dock.className).toContain("bg-card");
        expect(dock.className).not.toMatch(/border-l|before:|after:/);
        const statusIcon = dock.querySelector('[data-slot="redo-status-icon"]');
        expect(statusIcon).not.toBeNull();
        expect(statusIcon?.className).toMatch(/bg-orange/);
        expect(screen.getByText("Changes reverted")).not.toBeNull();
        expect(screen.getByText("3 messages · 2 files")).not.toBeNull();
        expect(screen.queryByText(/Operation/)).toBeNull();

        const redoButton = screen.getByRole("button", { name: "Redo" });
        const toggle = screen.getByRole("button", { name: "Show reverted details" });
        expect(redoButton).not.toBe(toggle);
        expect(dock.querySelectorAll("button")).toHaveLength(2);

        fireEvent.click(redoButton);
        expect(onRedo).toHaveBeenCalledOnce();
    });

    it("keeps collapsed details mounted but hidden from assistive technology with reduced-motion-safe transitions", () => {
        render(<RedoDock redo={makeRedo()} busy={false} onRedo={vi.fn()} />);

        const toggle = screen.getByRole("button", { name: "Show reverted details" });
        const details = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
        expect(details).not.toBeNull();
        expect(details?.textContent).toContain("Restore the original implementation");
        expect(details?.getAttribute("aria-hidden")).toBe("true");
        expect(details?.hasAttribute("role")).toBe(false);
        expect(details?.className).toContain("grid-rows-[0fr]");
        expect(details?.className).toContain("opacity-0");
        expect(details?.className).toContain("pointer-events-none");
        expect(details?.className).toContain("duration-200");
        expect(details?.className).toContain("motion-reduce:transition-none");
        expect(screen.queryByRole("region", { name: "Reverted operation details" })).toBeNull();
    });

    it("expands the reverted request and file details without exposing the operation id or moving Redo", () => {
        render(<RedoDock redo={makeRedo()} busy={false} onRedo={vi.fn()} />);

        const toggle = screen.getByRole("button", { name: "Show reverted details" });
        fireEvent.click(toggle);

        expect(screen.getByText("Reverted request")).not.toBeNull();
        expect(screen.getByText("Restore the original implementation")).not.toBeNull();
        expect(screen.getByText("Files")).not.toBeNull();
        expect(screen.getByText("2 files")).not.toBeNull();
        expect(screen.queryByText("operation-1")).toBeNull();
        expect(screen.queryByText(/Operation/)).toBeNull();
        expect(screen.getByRole("button", { name: "Redo" })).not.toBeNull();

        expect(getFileIconMock).toHaveBeenCalledWith("new.ts", false, false);
        expect(getFileIconMock).toHaveBeenCalledWith("removed.ts", false, false);
        expect(screen.getAllByTestId("redo-file-icon")).toHaveLength(2);
        const directories = screen.getAllByText("src/");
        expect(directories).toHaveLength(2);
        expect(directories[0].className).toContain("text-muted-foreground");
        expect(screen.getByText("new.ts").className).toContain("text-foreground");
        expect(screen.getByText("removed.ts").className).toContain("text-foreground");
        expect(screen.getByText("+4").className).toContain("text-success");
        expect(screen.getByText("-1").className).toContain("text-destructive");
        expect(screen.getByText("M")).not.toBeNull();
        expect(screen.getByText("D")).not.toBeNull();
        const fileRow = screen.getByText("new.ts").closest("li");
        expect(fileRow?.className).toContain("hover:bg-muted/40");
        expect(fileRow?.className).not.toMatch(/blue/);

        const details = screen.getByRole("region", { name: "Reverted operation details" });
        expect(toggle.getAttribute("aria-controls")).toBe(details.id);
        expect(toggle.getAttribute("aria-expanded")).toBe("true");
        expect(details.getAttribute("aria-hidden")).toBe("false");
        expect(details.className).toContain("grid-rows-[1fr]");
        expect(details.className).toContain("opacity-100");
        const scrollingBody = details.querySelector(".max-h-64");
        expect(scrollingBody?.className).toContain("overflow-y-auto");
    });

    it("explains authoritative file counts when session state has no inline file rows", () => {
        render(<RedoDock redo={makeRedo({ fileCount: 1, files: [] })} busy={false} onRedo={vi.fn()} />);

        fireEvent.click(screen.getByRole("button", { name: "Show reverted details" }));

        expect(screen.getByText("1 file")).not.toBeNull();
        const notice = screen.getByText("File details are available in the Redo preview.");
        expect(notice.className).toContain("text-muted-foreground");
        expect(getFileIconMock).not.toHaveBeenCalled();
    });

    it("uses explicit narrow-width placement for the Redo and toggle controls", () => {
        render(<RedoDock redo={makeRedo()} busy={false} onRedo={vi.fn()} />);

        const statusIcon = screen
            .getByRole("region", { name: "Reverted workspace changes" })
            .querySelector('[data-slot="redo-status-icon"]');
        expect(statusIcon).not.toBeNull();
        expect(statusIcon?.parentElement?.className).toContain(
            "[@container(max-width:30rem)]:grid-cols-[auto_minmax(0,1fr)_auto]"
        );

        const titleArea = screen.getByText("Changes reverted").parentElement;
        expect(titleArea?.className).toContain("[@container(max-width:30rem)]:block");

        const redoButton = screen.getByRole("button", { name: "Redo" });
        expect(redoButton.className).toContain("max-sm:col-span-3");
        expect(redoButton.className).toContain("max-sm:row-start-2");
        expect(redoButton.className).toContain("max-sm:w-full");
        expect(redoButton.className).toContain("[@container(max-width:30rem)]:col-span-3");
        expect(redoButton.className).toContain("[@container(max-width:30rem)]:row-start-2");
        expect(redoButton.className).toContain("[@container(max-width:30rem)]:w-full");

        const toggle = screen.getByRole("button", { name: "Show reverted details" });
        expect(toggle.className).toContain("max-sm:col-start-3");
        expect(toggle.className).toContain("max-sm:row-start-1");
        expect(toggle.className).toContain("[@container(max-width:30rem)]:col-start-3");
        expect(toggle.className).toContain("[@container(max-width:30rem)]:row-start-1");
        expect(toggle.className).toContain("focus-visible:ring");
    });

    it.each(["busy", "frozen", "applying"])("disables only Redo while the controller is %s", () => {
        const onRedo = vi.fn();
        render(<RedoDock redo={makeRedo()} busy onRedo={onRedo} />);

        const redoButton = screen.getByRole("button", { name: "Redo" });
        expect(redoButton.hasAttribute("disabled")).toBe(true);
        fireEvent.click(redoButton);
        expect(onRedo).not.toHaveBeenCalled();

        const toggle = screen.getByRole("button", { name: "Show reverted details" });
        expect(toggle.hasAttribute("disabled")).toBe(false);
        fireEvent.click(toggle);
        expect(screen.getByRole("region", { name: "Reverted operation details" })).not.toBeNull();
    });
});
