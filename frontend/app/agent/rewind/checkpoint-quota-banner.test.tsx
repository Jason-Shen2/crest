// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointQuotaBanner } from "./checkpoint-quota-banner";

afterEach(cleanup);

describe("CheckpointQuotaBanner", () => {
    it("is absent for healthy quota and remains controlled by authoritative quota after cleanup", () => {
        const onCleanup = vi.fn();
        const view = render(
            <CheckpointQuotaBanner
                quota={{
                    status: "ok",
                    usedBytes: 1,
                    softQuotaBytes: 10,
                    cleanupAvailable: false,
                }}
                busy={false}
                onCleanup={onCleanup}
                onManage={vi.fn()}
            />
        );
        expect(screen.queryByRole("status")).toBeNull();

        view.rerender(
            <CheckpointQuotaBanner
                quota={{
                    status: "soft-quota-exceeded",
                    usedBytes: 11,
                    softQuotaBytes: 10,
                    cleanupAvailable: true,
                }}
                busy={false}
                onCleanup={onCleanup}
                onManage={vi.fn()}
            />
        );
        fireEvent.click(screen.getByRole("button", { name: "Clean up unreferenced snapshots" }));

        expect(onCleanup).toHaveBeenCalledOnce();
        expect(screen.getByRole("status")).not.toBeNull();
    });

    it("explains referenced ownership and locks every maintenance entry while busy", () => {
        const onManage = vi.fn();
        render(
            <CheckpointQuotaBanner
                quota={{
                    status: "referenced-over-quota",
                    usedBytes: 12,
                    softQuotaBytes: 10,
                    cleanupAvailable: true,
                    message: "Referenced checkpoints exceed the storage quota",
                }}
                busy
                onCleanup={vi.fn()}
                onManage={onManage}
            />
        );

        const banner = screen.getByRole("status");
        expect(banner.textContent).toMatch(/still referenced by agent sessions/i);
        expect(banner.textContent).toMatch(/archive.*trash.*do not release/i);
        expect(banner.textContent).toMatch(/may remain referenced by workspace history/i);
        expect(banner.textContent).not.toMatch(/permanently delete.*to release/i);
        expect(banner.textContent).not.toMatch(/ref name|refs\/crest/i);
        expect(
            (screen.getByRole("button", { name: "Clean up unreferenced snapshots" }) as HTMLButtonElement).disabled
        ).toBe(true);
        const manageButton = screen.getByRole("button", { name: "Manage checkpoint storage" });
        expect((manageButton as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(manageButton);
        expect(onManage).not.toHaveBeenCalled();
    });

    it("locks cleanup and storage management while workspace recovery is frozen", () => {
        const onCleanup = vi.fn();
        const onManage = vi.fn();
        render(
            <CheckpointQuotaBanner
                quota={{
                    status: "soft-quota-exceeded",
                    usedBytes: 12,
                    softQuotaBytes: 10,
                    cleanupAvailable: true,
                }}
                busy={false}
                mutationsDisabled
                onCleanup={onCleanup}
                onManage={onManage}
            />
        );

        const cleanupButton = screen.getByRole("button", { name: "Clean up unreferenced snapshots" });
        const manageButton = screen.getByRole("button", { name: "Manage checkpoint storage" });
        expect((cleanupButton as HTMLButtonElement).disabled).toBe(true);
        expect((manageButton as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(cleanupButton);
        fireEvent.click(manageButton);
        expect(onCleanup).not.toHaveBeenCalled();
        expect(onManage).not.toHaveBeenCalled();
    });
});
