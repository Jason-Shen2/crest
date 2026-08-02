// @vitest-environment jsdom

// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { SVGProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileCard } from "./file-card";

const getFileIconMock = vi.hoisted(() => vi.fn());

vi.mock("@/app/fileexplorer/file-icon", () => ({
    getFileIcon: getFileIconMock,
}));

function TestFileIcon({ className, size, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
    return <svg {...props} data-testid="file-icon" className={className} data-size={size} />;
}

afterEach(cleanup);

beforeEach(() => {
    getFileIconMock.mockReset();
    getFileIconMock.mockReturnValue(TestFileIcon);
});

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

    it("uses the resolved repository icon for the filename basename", () => {
        const { container } = render(<FileCard filename="docs/README.md">content</FileCard>);

        expect(getFileIconMock).toHaveBeenCalledWith("README.md", false, false);
        expect(screen.getByTestId("file-icon").getAttribute("data-size")).toBe("16");
        expect(container.querySelector('[data-slot="file-card-file-icon"]')).not.toBeNull();
        expect(container.querySelector('[data-slot="file-card-file-badge"]')).toBeNull();
    });

    it("does not resolve or render an icon when showIcon is false", () => {
        render(
            <FileCard filename="docs/README.md" showIcon={false}>
                content
            </FileCard>
        );

        expect(getFileIconMock).not.toHaveBeenCalled();
        expect(screen.queryByTestId("file-icon")).toBeNull();
    });
});
