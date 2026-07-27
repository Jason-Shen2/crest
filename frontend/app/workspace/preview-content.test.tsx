// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewContent } from "./preview-content";

vi.mock("@/app/element/markdown", () => ({
    Markdown: ({ text }: { text: string }) => <div>markdown:{text}</div>,
}));
vi.mock("@/app/view/preview/csvview", () => ({
    CSVView: ({ content }: { content: string }) => <div>csv:{content}</div>,
}));
vi.mock("@/app/view/preview/preview-streaming", () => ({
    StreamingPreviewContent: ({ url }: { url: string }) => <img src={url} />,
}));

afterEach(cleanup);

describe("PreviewContent", () => {
    it("renders markdown, text, csv, directories, and streams from result props", () => {
        const view = render(
            <PreviewContent
                result={{ path: "/a.md", kind: "markdown", mimeType: "text/markdown", content: "# A" }}
                onOpenFile={vi.fn()}
            />
        );
        expect(screen.getByText("markdown:# A")).toBeTruthy();

        view.rerender(
            <PreviewContent
                result={{ path: "/a.txt", kind: "text", mimeType: "text/plain", content: "plain" }}
                onOpenFile={vi.fn()}
            />
        );
        expect(screen.getByText("plain")).toBeTruthy();

        view.rerender(
            <PreviewContent
                result={{ path: "/a.csv", kind: "csv", mimeType: "text/csv", content: "a,b" }}
                onOpenFile={vi.fn()}
            />
        );
        expect(screen.getByText("csv:a,b")).toBeTruthy();

        view.rerender(
            <PreviewContent
                result={{
                    path: "/repo",
                    kind: "directory",
                    mimeType: "directory",
                    entries: [{ path: "/repo/a.txt", name: "a.txt" }],
                }}
                onOpenFile={vi.fn()}
            />
        );
        expect(screen.getByText("a.txt")).toBeTruthy();

        view.rerender(
            <PreviewContent
                result={{
                    path: "/a.png",
                    kind: "stream",
                    mediaKind: "image",
                    mimeType: "image/png",
                    url: "http://stream/a.png",
                }}
                onOpenFile={vi.fn()}
            />
        );
        expect(screen.getByRole("img").getAttribute("src")).toBe("http://stream/a.png");
    });

    it("offers Open as File for file-only results", () => {
        const onOpenFile = vi.fn();
        render(
            <PreviewContent
                result={{
                    path: "/large.txt",
                    kind: "file-only",
                    mimeType: "text/plain",
                    reason: "too-large",
                }}
                onOpenFile={onOpenFile}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "Open as File" }));
        expect(onOpenFile).toHaveBeenCalledWith("/large.txt");
    });

    it("makes directory entries accessible navigation controls", () => {
        const onOpenPath = vi.fn();
        render(
            <PreviewContent
                result={{
                    path: "/repo",
                    kind: "directory",
                    mimeType: "directory",
                    entries: [{ path: "/repo/child", name: "child", isdir: true }],
                }}
                onOpenFile={vi.fn()}
                onOpenPath={onOpenPath}
            />
        );

        fireEvent.click(screen.getByRole("button", { name: "child" }));
        expect(onOpenPath).toHaveBeenCalledWith({ path: "/repo/child", name: "child", isdir: true });
    });

    it("renders capped directory entries and reports the remainder", () => {
        const entries = Array.from({ length: 1000 }, (_, index) => ({
            path: `/repo/${index}.txt`,
            name: `${index}.txt`,
        }));
        render(
            <PreviewContent
                result={{
                    path: "/repo",
                    kind: "directory",
                    mimeType: "directory",
                    entries,
                    truncated: true,
                }}
                onOpenFile={vi.fn()}
                onOpenPath={vi.fn()}
            />
        );

        expect(screen.getAllByRole("button")).toHaveLength(1000);
        expect(screen.getByText("More entries not shown")).toBeTruthy();
    });
});
