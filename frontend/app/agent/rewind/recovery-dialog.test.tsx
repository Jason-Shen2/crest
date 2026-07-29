// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecoveryDialog } from "./recovery-dialog";

const Recovery: AgentWorkspaceRecoveryView = {
    operationId: "operation-17",
    phase: "applying_files",
    corrupt: false,
    message: "Workspace files need recovery before the agent can continue.",
    paths: [
        { path: "src/changed.ts", classification: "target" },
        { path: "src/unknown.ts", classification: "unknown" },
    ],
    allowedActions: ["retry", "abandon-current"],
};

afterEach(cleanup);

describe("RecoveryDialog", () => {
    it("renders authoritative diagnostics and only backend-allowed actions", () => {
        const onAction = vi.fn();
        render(<RecoveryDialog open recovery={Recovery} busy={false} onAction={onAction} onClose={vi.fn()} />);

        expect(screen.getByText("operation-17")).not.toBeNull();
        expect(screen.getByText("applying files")).not.toBeNull();
        expect(screen.getByText("src/changed.ts")).not.toBeNull();
        expect(screen.getByText("target")).not.toBeNull();
        expect(screen.getByText("src/unknown.ts")).not.toBeNull();
        expect(screen.getByText(Recovery.message)).not.toBeNull();
        expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
        expect(screen.getByRole("button", { name: "Keep current and abandon operation" })).not.toBeNull();
        expect(screen.queryByText(/force/i)).toBeNull();
        expect(screen.queryByRole("button", { name: /quarantine/i })).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        fireEvent.click(screen.getByRole("button", { name: "Keep current and abandon operation" }));

        expect(onAction.mock.calls).toEqual([["retry"], ["abandon-current"]]);
    });

    it("shows quarantine only when allowed and locks mutations while resolving", () => {
        const onAction = vi.fn();
        render(
            <RecoveryDialog
                open
                recovery={{
                    ...Recovery,
                    corrupt: true,
                    allowedActions: ["quarantine-corrupt"],
                }}
                busy
                errorMessage="Recovery is still busy."
                onAction={onAction}
                onClose={vi.fn()}
            />
        );

        expect(screen.getByRole("alert").textContent).toContain("Recovery is still busy.");
        const quarantine = screen.getByRole("button", {
            name: "Quarantine corrupt record and keep current",
        }) as HTMLButtonElement;
        expect(quarantine.disabled).toBe(true);
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
        expect(screen.queryByText(/force/i)).toBeNull();
    });
});
