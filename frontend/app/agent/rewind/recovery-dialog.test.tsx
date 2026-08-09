// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RecoveryDialog } from "./recovery-dialog";

const Recovery: AgentWorkspaceRecoveryView = {
    operationId: "operation-17",
    corrupt: false,
    message: "Workspace files need recovery before the agent can continue.",
    paths: [
        { path: "src/changed.ts", classification: "target" },
        { path: "src/unknown.ts", classification: "unknown" },
    ],
    allowedActions: ["retry"],
};

afterEach(cleanup);

describe("RecoveryDialog", () => {
    it("renders authoritative diagnostics and only backend-allowed actions", () => {
        const onAction = vi.fn();
        render(<RecoveryDialog open recovery={Recovery} busy={false} onAction={onAction} onClose={vi.fn()} />);

        expect(screen.getByText("operation-17")).not.toBeNull();
        expect(screen.queryByText(/phase/i)).toBeNull();
        expect(screen.getByText("src/changed.ts")).not.toBeNull();
        expect(screen.getByText("target")).not.toBeNull();
        expect(screen.getByText("src/unknown.ts")).not.toBeNull();
        expect(screen.getByText(Recovery.message)).not.toBeNull();
        expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
        expect(screen.queryByText(/force/i)).toBeNull();
        expect(screen.getAllByRole("button")).toHaveLength(2);

        fireEvent.click(screen.getByRole("button", { name: "Retry" }));

        expect(onAction).toHaveBeenCalledWith("retry");
    });

    it("keeps retry as the only action and locks it while resolving corrupt facts", () => {
        const onAction = vi.fn();
        render(
            <RecoveryDialog
                open
                recovery={{
                    ...Recovery,
                    corrupt: true,
                }}
                busy
                errorMessage="Recovery is still busy."
                onAction={onAction}
                onClose={vi.fn()}
            />
        );

        expect(screen.getByRole("alert").textContent).toContain("Recovery is still busy.");
        const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
        expect(retry.disabled).toBe(true);
        expect(screen.getAllByRole("button")).toHaveLength(2);
        expect(screen.queryByText(/force/i)).toBeNull();
    });
});
