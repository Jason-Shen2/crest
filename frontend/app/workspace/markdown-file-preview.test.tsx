// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownFilePreview } from "./markdown-file-preview";

type CapturedMarkdownProps = {
    text: string;
    resolveOpts: MarkdownResolveOpts;
    contentClassName: string;
};

const markdownProps = vi.hoisted(() => ({ current: null as CapturedMarkdownProps }));

vi.mock("@/app/element/markdown", () => ({
    Markdown: (props: CapturedMarkdownProps) => {
        markdownProps.current = props;
        return <div data-testid="markdown-adapter">{props.text}</div>;
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
});
