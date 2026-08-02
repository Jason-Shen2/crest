// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { resolveRemoteFile } from "@/app/element/markdown-util";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
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
        markdownProps.current = {
            text: props.text,
            resolveOpts: props.resolveOpts,
            contentClassName: props.contentClassName,
        };
        return (
            <>
                <div data-testid="markdown-adapter">{props.text}</div>
                <span data-testid="markdown-mount-id">{mountId.current}</span>
            </>
        );
    },
}));

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    delete (window as any).api;
});

describe("MarkdownFilePreview", () => {
    it("renders markdown text with its local parent directory", () => {
        render(<MarkdownFilePreview path="/repo/docs/README.md" text="# First" />);

        const adapter = screen.getByTestId("markdown-adapter");
        expect(adapter.textContent).toBe("# First");
        expect(adapter.parentElement.className.split(" ")).toContain("@container");
        expect(markdownProps.current).toMatchObject({
            text: "# First",
            resolveOpts: { connName: "local", baseDir: "/repo/docs" },
            contentClassName: "px-6 py-5 [@container(max-width:40rem)]:px-4 [@container(max-width:40rem)]:py-4",
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

    it.each([
        ["POSIX", "/repo/docs/README.md", "wsh://local//repo/docs"],
        ["Windows drive", "C:/docs/README.md", "wsh://local/C:/docs"],
        ["UNC", "//server/share/README.md", "wsh://local///server/share"],
    ])("wires %s parent paths through the real remote-file resolver", async (_kind, path, expectedBaseUri) => {
        const fileJoin = vi.spyOn(RpcApi, "FileJoinCommand").mockResolvedValue({ path: "/resolved/logo.png" } as any);
        (window as any).api = { getEnv: vi.fn(() => "localhost") };
        render(<MarkdownFilePreview path={path} text="![Logo](assets/logo.png)" />);

        await resolveRemoteFile("assets/logo.png", markdownProps.current.resolveOpts);

        expect(fileJoin).toHaveBeenCalledWith(TabRpcClient, [expectedBaseUri, "assets/logo.png"]);
    });

    it("remounts Markdown when the file path changes", () => {
        const view = render(<MarkdownFilePreview path="C:/docs/README.md" text="![Logo](logo.png)" />);
        const firstMountId = screen.getByTestId("markdown-mount-id").textContent;

        view.rerender(<MarkdownFilePreview path="//server/share/README.md" text="![Logo](logo.png)" />);

        expect(screen.getByTestId("markdown-mount-id").textContent).not.toBe(firstMountId);
    });
});
