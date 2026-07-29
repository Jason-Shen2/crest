// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointQuotaDialog } from "./checkpoint-quota-dialog";

const TrashOwner: AgentCheckpointTrashOwnerView = {
    sessionId: "trash-session",
    title: "Discarded experiment",
    referencedBytes: 4096,
    confirmationToken: "opaque-token",
};

afterEach(cleanup);

describe("CheckpointQuotaDialog", () => {
    it("renders only backend owners and requires a second explicit confirmation", () => {
        const onPurge = vi.fn();
        render(
            <CheckpointQuotaDialog
                open
                owners={[TrashOwner]}
                phase="ready"
                onClose={vi.fn()}
                onPurge={onPurge}
                onRefresh={vi.fn()}
            />
        );

        expect(screen.getByText("Discarded experiment")).not.toBeNull();
        expect(screen.getByText("trash-session")).not.toBeNull();
        expect(screen.queryByText(/active|archive/i)).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Permanently delete Discarded experiment" }));
        expect(onPurge).not.toHaveBeenCalled();
        const confirmation = screen.getByRole("alertdialog", {
            name: "Permanently delete Discarded experiment",
        });
        expect(confirmation.getAttribute("aria-describedby")).toBeTruthy();
        expect(screen.getByText(/cannot be undone/i)).not.toBeNull();
        expect(screen.getByRole("button", { name: "Confirm permanent deletion of Discarded experiment" })).toBe(
            document.activeElement
        );

        fireEvent.click(screen.getByRole("button", { name: "Confirm permanent deletion of Discarded experiment" }));
        expect(onPurge).toHaveBeenCalledWith({
            trashedSessionId: "trash-session",
            confirmationToken: "opaque-token",
        });
        expect(screen.getByText("Discarded experiment")).not.toBeNull();
    });

    it("keeps rows and locks refresh, close, and new purge attempts while purging", () => {
        const onRefresh = vi.fn();
        const onClose = vi.fn();
        const onPurge = vi.fn();
        render(
            <CheckpointQuotaDialog
                open
                owners={[TrashOwner]}
                phase="purging"
                errorMessage="The purge token is stale because the session was restored or storage is busy."
                onClose={onClose}
                onPurge={onPurge}
                onRefresh={onRefresh}
            />
        );

        expect(screen.getByRole("alert").textContent).toMatch(/stale.*restored.*busy/i);
        expect(screen.getByText("Discarded experiment")).not.toBeNull();
        expect(
            (screen.getByRole("button", { name: "Permanently delete Discarded experiment" }) as HTMLButtonElement)
                .disabled
        ).toBe(true);
        fireEvent.click(screen.getByRole("button", { name: "Refresh storage diagnostics" }));
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(onRefresh).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
        expect(onPurge).not.toHaveBeenCalled();
    });

    it("locks every dialog maintenance entry while another maintenance operation owns the mutex", () => {
        const onRefresh = vi.fn();
        const onClose = vi.fn();
        render(
            <CheckpointQuotaDialog
                open
                maintenanceBusy
                owners={[TrashOwner]}
                phase="ready"
                onClose={onClose}
                onPurge={vi.fn()}
                onRefresh={onRefresh}
            />
        );

        const purge = screen.getByRole("button", { name: "Permanently delete Discarded experiment" });
        const refresh = screen.getByRole("button", { name: "Refresh storage diagnostics" });
        const close = screen.getByRole("button", { name: "Close" });
        expect((purge as HTMLButtonElement).disabled).toBe(true);
        expect((refresh as HTMLButtonElement).disabled).toBe(true);
        expect((close as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(refresh);
        fireEvent.click(close);
        expect(onRefresh).not.toHaveBeenCalled();
        expect(onClose).not.toHaveBeenCalled();
    });

    it("keeps a double-failure owner visible but stale until an explicit refresh", () => {
        const onRefresh = vi.fn();
        const onPurge = vi.fn();
        render(
            <CheckpointQuotaDialog
                open
                owners={[TrashOwner]}
                phase="error"
                errorMessage="Purge failed and storage diagnostics could not be refreshed."
                onClose={vi.fn()}
                onPurge={onPurge}
                onRefresh={onRefresh}
                staleOwnerIds={[TrashOwner.sessionId]}
            />
        );

        expect(screen.getByText("Discarded experiment")).not.toBeNull();
        expect(screen.getByText(/purge status is unknown.*refresh storage diagnostics/i)).not.toBeNull();
        const purge = screen.getByRole("button", { name: "Permanently delete Discarded experiment" });
        expect(purge.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(purge);
        expect(onPurge).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Refresh storage diagnostics" }));
        expect(onRefresh).toHaveBeenCalledOnce();
    });

    it("closes stale confirmation and requires a fresh first click after owner token refresh", () => {
        const onPurge = vi.fn();
        const props = {
            open: true,
            phase: "ready" as const,
            onClose: vi.fn(),
            onPurge,
            onRefresh: vi.fn(),
        };
        const { rerender } = render(<CheckpointQuotaDialog {...props} owners={[TrashOwner]} />);
        const originalTrigger = screen.getByRole("button", {
            name: "Permanently delete Discarded experiment",
        });
        fireEvent.click(originalTrigger);
        expect(screen.getByRole("alertdialog")).not.toBeNull();

        rerender(
            <CheckpointQuotaDialog
                {...props}
                errorMessage="Purge failed and storage diagnostics could not be refreshed."
                owners={[TrashOwner]}
                phase="error"
                staleOwnerIds={[TrashOwner.sessionId]}
            />
        );
        expect(screen.queryByRole("alertdialog")).toBeNull();
        expect(originalTrigger).toBe(document.activeElement);

        const refreshedOwner = { ...TrashOwner, confirmationToken: "fresh-token" };
        rerender(<CheckpointQuotaDialog {...props} owners={[refreshedOwner]} />);
        expect(screen.queryByRole("alertdialog")).toBeNull();
        const refreshedTrigger = screen.getByRole("button", {
            name: "Permanently delete Discarded experiment",
        });
        fireEvent.click(refreshedTrigger);
        expect(onPurge).not.toHaveBeenCalled();
        expect(screen.getByRole("alertdialog")).not.toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Confirm permanent deletion of Discarded experiment" }));
        expect(onPurge).toHaveBeenCalledWith({
            trashedSessionId: TrashOwner.sessionId,
            confirmationToken: "fresh-token",
        });
    });

    it("closes an open confirmation when the same owner receives a different token", () => {
        const props = {
            open: true,
            phase: "ready" as const,
            onClose: vi.fn(),
            onPurge: vi.fn(),
            onRefresh: vi.fn(),
        };
        const { rerender } = render(<CheckpointQuotaDialog {...props} owners={[TrashOwner]} />);
        const trigger = screen.getByRole("button", { name: "Permanently delete Discarded experiment" });
        fireEvent.click(trigger);
        expect(screen.getByRole("alertdialog")).not.toBeNull();

        rerender(
            <CheckpointQuotaDialog {...props} owners={[{ ...TrashOwner, confirmationToken: "replacement-token" }]} />
        );

        expect(screen.queryByRole("alertdialog")).toBeNull();
        expect(trigger).toBe(document.activeElement);
    });

    it("cancels owner confirmation with Escape and restores focus to its expanded control", () => {
        render(
            <CheckpointQuotaDialog
                open
                owners={[TrashOwner]}
                phase="ready"
                onClose={vi.fn()}
                onPurge={vi.fn()}
                onRefresh={vi.fn()}
            />
        );
        const trigger = screen.getByRole("button", { name: "Permanently delete Discarded experiment" });
        fireEvent.click(trigger);
        expect(trigger.getAttribute("aria-expanded")).toBe("true");

        fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });

        expect(screen.queryByRole("alertdialog")).toBeNull();
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
        expect(trigger).toBe(document.activeElement);
    });
});
