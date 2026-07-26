// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspacePreviewRepository } from "./preview-repository";
import { PreviewTopTab } from "./preview-top-tab";
import type { WorkspaceTopTabController } from "./top-tab-controller";

afterEach(cleanup);

describe("PreviewTopTab", () => {
    it("loads only while mounted and opens file-only content through the controller", async () => {
        const repository = {
            load: vi.fn(async () => ({
                path: "/repo/large.txt",
                kind: "file-only" as const,
                mimeType: "text/plain",
                reason: "too-large" as const,
            })),
        } as unknown as WorkspacePreviewRepository;
        const controller = { openFile: vi.fn() } as unknown as WorkspaceTopTabController;
        const view = render(
            <PreviewTopTab
                tab={{ id: "preview-1", kind: "preview", path: "/repo/large.txt", title: "large.txt" }}
                repository={repository}
                controller={controller}
            />
        );

        expect(await screen.findByRole("button", { name: "Open as File" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Open as File" }));
        expect(controller.openFile).toHaveBeenCalledWith("/repo/large.txt");
        view.unmount();
        expect(repository.load).toHaveBeenCalledTimes(1);
    });

    it("retries with a local request generation and ignores a stale failure", async () => {
        let rejectFirst: (error: Error) => void;
        const first = new Promise<never>((_, reject) => {
            rejectFirst = reject;
        });
        const repository = {
            load: vi
                .fn()
                .mockImplementationOnce(() => first)
                .mockResolvedValueOnce({
                    path: "/repo/a.txt",
                    kind: "text",
                    mimeType: "text/plain",
                    content: "recovered",
                }),
        } as unknown as WorkspacePreviewRepository;
        const view = render(
            <PreviewTopTab
                tab={{ id: "preview-1", kind: "preview", path: "/repo/a.txt", title: "a.txt" }}
                repository={repository}
                controller={{ openFile: vi.fn() } as unknown as WorkspaceTopTabController}
            />
        );

        rejectFirst(new Error("failed"));
        expect(await screen.findByText("failed")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
        expect(await screen.findByText("recovered")).toBeTruthy();
        view.unmount();
    });

    it("opens a safe child entry as a preview", async () => {
        const repository = {
            load: vi.fn(async () => ({
                path: "/repo",
                kind: "directory" as const,
                mimeType: "directory",
                entries: [{ name: "child", isdir: true }],
            })),
        } as unknown as WorkspacePreviewRepository;
        const controller = { openPreview: vi.fn() } as unknown as WorkspaceTopTabController;
        render(
            <PreviewTopTab
                tab={{ id: "preview-1", kind: "preview", path: "/repo", title: "repo" }}
                repository={repository}
                controller={controller}
            />
        );

        fireEvent.click(await screen.findByRole("button", { name: "child" }));
        expect(controller.openPreview).toHaveBeenCalledWith("/repo/child");
    });

    it("ignores directory entry paths that escape the preview root", async () => {
        const repository = {
            load: vi.fn(async () => ({
                path: "/repo",
                kind: "directory" as const,
                mimeType: "directory",
                entries: [{ path: "/outside/secret", name: "secret" }],
            })),
        } as unknown as WorkspacePreviewRepository;
        const controller = { openPreview: vi.fn() } as unknown as WorkspaceTopTabController;
        render(
            <PreviewTopTab
                tab={{ id: "preview-1", kind: "preview", path: "/repo", title: "repo" }}
                repository={repository}
                controller={controller}
            />
        );

        fireEvent.click(await screen.findByRole("button", { name: "secret" }));
        expect(controller.openPreview).not.toHaveBeenCalled();
    });

    it("ignores URI-shaped directory entry paths", async () => {
        const repository = {
            load: vi.fn(async () => ({
                path: "/repo",
                kind: "directory" as const,
                mimeType: "directory",
                entries: [{ path: "wsh://host/secret", name: "secret" }],
            })),
        } as unknown as WorkspacePreviewRepository;
        const controller = { openPreview: vi.fn() } as unknown as WorkspaceTopTabController;
        render(
            <PreviewTopTab
                tab={{ id: "preview-1", kind: "preview", path: "/repo", title: "repo" }}
                repository={repository}
                controller={controller}
            />
        );

        fireEvent.click(await screen.findByRole("button", { name: "secret" }));
        expect(controller.openPreview).not.toHaveBeenCalled();
    });
});
