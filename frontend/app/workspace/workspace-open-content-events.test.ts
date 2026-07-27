// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const subscription = vi.hoisted(() => ({
    handler: undefined as ((event: any) => void) | undefined,
    unsubscribe: vi.fn(),
}));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (input: any) => {
        subscription.handler = input.handler;
        return subscription.unsubscribe;
    },
}));

import { subscribeWorkspaceOpenContentEvents } from "./workspace-open-content-events";

describe("workspace:open-content", () => {
    beforeEach(() => {
        subscription.handler = undefined;
        subscription.unsubscribe.mockReset();
    });

    it("filters workspace, generation, payload, and duplicate request ids", () => {
        let current = true;
        const controller = { openPreview: vi.fn() };
        const dispose = subscribeWorkspaceOpenContentEvents({
            workspaceId: "workspace-1",
            generation: 2,
            controller,
            isCurrent: () => current,
        });
        const event = {
            event: "workspace:open-content",
            data: { workspaceid: "workspace-1", kind: "preview", path: "/repo/a.md", requestid: "request-1" },
        };
        subscription.handler?.(event);
        subscription.handler?.(event);
        current = false;
        subscription.handler?.({ ...event, data: { ...event.data, requestid: "request-2" } });
        dispose();
        subscription.handler?.({ ...event, data: { ...event.data, requestid: "request-3" } });

        expect(controller.openPreview).toHaveBeenCalledOnce();
        expect(controller.openPreview).toHaveBeenCalledWith("/repo/a.md");
        expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    });

    it("disposes the old generation and opens through the replacement generation", () => {
        const oldController = { openPreview: vi.fn() };
        const disposeOld = subscribeWorkspaceOpenContentEvents({
            workspaceId: "workspace-1",
            generation: 1,
            controller: oldController,
            isCurrent: (_workspaceId, generation) => generation === 1,
        });
        disposeOld();
        const currentController = { openPreview: vi.fn() };
        subscribeWorkspaceOpenContentEvents({
            workspaceId: "workspace-1",
            generation: 2,
            controller: currentController,
            isCurrent: (_workspaceId, generation) => generation === 2,
        });
        subscription.handler?.({
            event: "workspace:open-content",
            data: { workspaceid: "workspace-1", kind: "preview", path: "/repo/new.md", requestid: "new" },
        });

        expect(oldController.openPreview).not.toHaveBeenCalled();
        expect(currentController.openPreview).toHaveBeenCalledWith("/repo/new.md");
    });

    it.each([
        ["cross-workspace", { workspaceid: "workspace-2", kind: "preview", path: "/repo/a.md", requestid: "cross" }],
        ["non-preview kind", { workspaceid: "workspace-1", kind: "file", path: "/repo/a.md", requestid: "kind" }],
        ["relative path", { workspaceid: "workspace-1", kind: "preview", path: "repo/a.md", requestid: "relative" }],
    ])("ignores %s events", (_name, data) => {
        const controller = { openPreview: vi.fn() };
        subscribeWorkspaceOpenContentEvents({
            workspaceId: "workspace-1",
            generation: 2,
            controller,
            isCurrent: () => true,
        });

        subscription.handler?.({ event: "workspace:open-content", data });

        expect(controller.openPreview).not.toHaveBeenCalled();
    });

    it("deduplicates request ids", () => {
        const controller = { openPreview: vi.fn() };
        subscribeWorkspaceOpenContentEvents({
            workspaceId: "workspace-1",
            generation: 2,
            controller,
            isCurrent: () => true,
        });
        const event = {
            event: "workspace:open-content",
            data: { workspaceid: "workspace-1", kind: "preview", path: "/repo/a.md", requestid: "duplicate" },
        };

        subscription.handler?.(event);
        subscription.handler?.(event);

        expect(controller.openPreview).toHaveBeenCalledOnce();
    });

    it("ignores stale generations and events after disposal", () => {
        const controller = { openPreview: vi.fn() };
        let currentGeneration = 3;
        const dispose = subscribeWorkspaceOpenContentEvents({
            workspaceId: "workspace-1",
            generation: 2,
            controller,
            isCurrent: (_workspaceId, generation) => generation === currentGeneration,
        });
        const event = {
            event: "workspace:open-content",
            data: { workspaceid: "workspace-1", kind: "preview", path: "/repo/a.md", requestid: "stale" },
        };

        subscription.handler?.(event);
        currentGeneration = 2;
        dispose();
        subscription.handler?.({ ...event, data: { ...event.data, requestid: "disposed" } });

        expect(controller.openPreview).not.toHaveBeenCalled();
        expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    });

    it.each(["/repo/a.md", "C:\\repo\\a.md", "\\\\server\\share\\a.md"])(
        "accepts cross-platform absolute preview path %s",
        (path) => {
            const controller = { openPreview: vi.fn() };
            subscribeWorkspaceOpenContentEvents({
                workspaceId: "workspace-1",
                generation: 2,
                controller,
                isCurrent: () => true,
            });
            subscription.handler?.({
                event: "workspace:open-content",
                data: { workspaceid: "workspace-1", kind: "preview", path, requestid: path },
            });
            expect(controller.openPreview).toHaveBeenCalledWith(path);
        }
    );

    it("evicts old request ids when the dedupe capacity is exceeded", () => {
        const controller = { openPreview: vi.fn() };
        subscribeWorkspaceOpenContentEvents({
            workspaceId: "workspace-1",
            generation: 2,
            controller,
            isCurrent: () => true,
        });
        for (let index = 0; index <= 256; index++) {
            subscription.handler?.({
                event: "workspace:open-content",
                data: {
                    workspaceid: "workspace-1",
                    kind: "preview",
                    path: "/repo/a.md",
                    requestid: `request-${index}`,
                },
            });
        }
        subscription.handler?.({
            event: "workspace:open-content",
            data: {
                workspaceid: "workspace-1",
                kind: "preview",
                path: "/repo/a.md",
                requestid: "request-0",
            },
        });

        expect(controller.openPreview).toHaveBeenCalledTimes(258);
    });

    it("accepts a request id again after the dedupe TTL", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-07-26T00:00:00Z"));
        const controller = { openPreview: vi.fn() };
        subscribeWorkspaceOpenContentEvents({
            workspaceId: "workspace-1",
            generation: 2,
            controller,
            isCurrent: () => true,
        });
        const event = {
            event: "workspace:open-content",
            data: { workspaceid: "workspace-1", kind: "preview", path: "/repo/a.md", requestid: "ttl" },
        };
        subscription.handler?.(event);
        vi.advanceTimersByTime(5 * 60 * 1000 + 1);
        subscription.handler?.(event);
        vi.useRealTimers();

        expect(controller.openPreview).toHaveBeenCalledTimes(2);
    });
});
