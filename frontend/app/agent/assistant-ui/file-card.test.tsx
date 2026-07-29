// @vitest-environment jsdom

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FileCard } from "./file-card";

afterEach(cleanup);

describe("FileCard", () => {
    it("starts expanded and toggles from the full header", () => {
        render(
            <FileCard filename="src/app.ts" additions={2} deletions={1}>
                <div>body</div>
            </FileCard>
        );

        const header = screen.getByRole("button", { name: /src\/app\.ts/i });
        expect(header.getAttribute("aria-expanded")).toBe("true");
        expect(screen.getByText("body")).toBeTruthy();
        expect(header.textContent).toContain("+2");
        expect(header.textContent).toContain("-1");

        fireEvent.click(header);

        expect(header.getAttribute("aria-expanded")).toBe("false");
        expect(screen.queryByText("body")).toBeNull();
    });

    it("omits stats when they are not supplied", () => {
        const { container } = render(<FileCard filename="README.md">content</FileCard>);

        expect(screen.getByRole("button", { name: /README\.md/i }).textContent).not.toContain("+");
        expect(container.querySelector('[data-slot="file-card-stats"]')).toBeNull();
    });
});
