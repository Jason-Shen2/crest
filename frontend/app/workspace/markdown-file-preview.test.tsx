// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownFilePreview } from "./markdown-file-preview";

type CapturedMarkdownProps = {
    text: string;
    resolveOpts: MarkdownResolveOpts;
    contentClassName: string;
};

const markdownProps = vi.hoisted(() => ({
    current: null as CapturedMarkdownProps,
    nextMountId: 0,
}));

vi.mock("@/app/element/markdown", () => ({
    Markdown: (props: CapturedMarkdownProps) => {
        const mountId = useRef<number>(null);
        if (mountId.current == null) {
            mountId.current = ++markdownProps.nextMountId;
        }
        markdownProps.current = props;
        return (
            <>
                <div data-testid="markdown-adapter">{props.text}</div>
                <span data-testid="markdown-mount-id">{mountId.current}</span>
            </>
        );
    },
}));

afterEach(cleanup);

describe("MarkdownFilePreview", () => {
    it("renders markdown text with its local parent directory", () => {
        render(<MarkdownFilePreview path="/repo/docs/README.md" text="# First" />);

        expect(screen.getByTestId("markdown-adapter").textContent).toBe("# First");
        expect(markdownProps.current).toMatchObject({
            text: "# First",
            resolveOpts: { connName: "local", baseDir: "/repo/docs" },
            contentClassName: "px-6 py-5",
        });
    });

    it("passes the latest text after rerendering", () => {
        const view = render(<MarkdownFilePreview path="/repo/docs/README.md" text="# First" />);

        view.rerender(<MarkdownFilePreview path="/repo/docs/README.md" text="# Edited" />);

        expect(markdownProps.current.text).toBe("# Edited");
    });

    it("updates the base directory when a Windows path changes to a UNC path", () => {
        const view = render(<MarkdownFilePreview path="C:/docs/README.md" text="# First" />);

        expect(markdownProps.current.resolveOpts.baseDir).toBe("C:/docs");

        view.rerender(<MarkdownFilePreview path="//server/share/README.md" text="# First" />);

        expect(markdownProps.current.resolveOpts.baseDir).toBe("//server/share");
    });

    it("remounts Markdown when the file path changes", () => {
        const view = render(<MarkdownFilePreview path="C:/docs/README.md" text="![Logo](logo.png)" />);
        const firstMountId = screen.getByTestId("markdown-mount-id").textContent;

        view.rerender(<MarkdownFilePreview path="//server/share/README.md" text="![Logo](logo.png)" />);

        expect(screen.getByTestId("markdown-mount-id").textContent).not.toBe(firstMountId);
    });
});
