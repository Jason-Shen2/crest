// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TopTabCloseDialog, TopTabCloseDialogController } from "./top-tab-close-dialog";

describe("TopTabCloseDialog", () => {
    it("queues requests and resolves all outstanding requests as cancel on unmount", async () => {
        const controller = new TopTabCloseDialogController();
        const first = controller.requestDecision({ topTabId: "one", title: "one.ts" });
        const second = controller.requestDecision({ topTabId: "two", title: "two.ts" });
        const view = render(<TopTabCloseDialog controller={controller} />);
        fireEvent.click(screen.getByRole("button", { name: "Discard" }));
        await expect(first).resolves.toBe("discard");
        expect(screen.getByText(/two.ts/)).toBeTruthy();
        act(() => view.unmount());
        await expect(second).resolves.toBe("cancel");
    });
});
