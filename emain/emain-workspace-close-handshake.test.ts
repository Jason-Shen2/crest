// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceCloseHandshake } from "./emain-workspace-close-handshake";

function makeSender(id = 7) {
    const listeners = new Set<() => void>();
    return {
        id,
        destroyed: false,
        send: vi.fn(),
        isDestroyed() {
            return this.destroyed;
        },
        once: vi.fn((_event: "destroyed", listener: () => void) => listeners.add(listener)),
        removeListener: vi.fn((_event: "destroyed", listener: () => void) => listeners.delete(listener)),
        destroy() {
            this.destroyed = true;
            [...listeners].forEach((listener) => listener());
        },
        listenerCount: () => listeners.size,
    };
}

afterEach(() => vi.useRealTimers());

describe("WorkspaceCloseHandshake", () => {
    it("times out after 30 seconds and cleans pending state and listener", async () => {
        vi.useFakeTimers();
        const sender = makeSender();
        const handshake = new WorkspaceCloseHandshake(() => sender);
        const result = handshake.request("window");
        expect(handshake.pending).toBeTruthy();

        await vi.advanceTimersByTimeAsync(30000);
        await expect(result).resolves.toBe(false);
        expect(handshake.pending).toBeUndefined();
        expect(sender.listenerCount()).toBe(0);
    });

    it("resolves false and cleans up when the renderer is destroyed", async () => {
        const sender = makeSender();
        const handshake = new WorkspaceCloseHandshake(() => sender);
        const result = handshake.request("quit");
        sender.destroy();
        await expect(result).resolves.toBe(false);
        expect(handshake.pending).toBeUndefined();
        expect(sender.listenerCount()).toBe(0);
    });

    it("ignores an unrelated stale request id", async () => {
        const sender = makeSender();
        const handshake = new WorkspaceCloseHandshake(() => sender);
        const result = handshake.request("workspace");
        const requestid = handshake.pending!.requestid;

        handshake.respond(sender.id, { requestid: "stale", allow: true });
        expect(handshake.pending?.requestid).toBe(requestid);
        handshake.respond(sender.id, { requestid, allow: true });
        await expect(result).resolves.toBe(true);
    });

    it("immediately rejects matching responses from a wrong or replaced renderer and permits retry", async () => {
        const sender = makeSender();
        let current = sender;
        const handshake = new WorkspaceCloseHandshake(() => current);
        const wrongSender = handshake.request("workspace");
        const requestid = handshake.pending!.requestid;
        handshake.respond(99, { requestid, allow: true });
        await expect(wrongSender).resolves.toBe(false);
        expect(handshake.pending).toBeUndefined();
        expect(sender.listenerCount()).toBe(0);

        const replaced = handshake.request("workspace");
        const replacedRequestid = handshake.pending!.requestid;
        current = makeSender(8);
        handshake.respond(sender.id, { requestid: replacedRequestid, allow: true });
        await expect(replaced).resolves.toBe(false);
        expect(handshake.pending).toBeUndefined();

        const retry = handshake.request("workspace");
        const retryRequestid = handshake.pending!.requestid;
        handshake.respond(current.id, { requestid: retryRequestid, allow: true });
        await expect(retry).resolves.toBe(true);
    });

    it("does not overwrite an in-flight resolver with a concurrent request", async () => {
        const sender = makeSender();
        const handshake = new WorkspaceCloseHandshake(() => sender);
        const first = handshake.request("window");
        await expect(handshake.request("window")).resolves.toBe(false);
        const requestid = handshake.pending!.requestid;
        handshake.respond(sender.id, { requestid, allow: true });
        await expect(first).resolves.toBe(true);
    });

    it("contains synchronous send failure, cleans up, and allows a subsequent request", async () => {
        const sender = makeSender();
        sender.send.mockImplementationOnce(() => {
            throw new Error("renderer gone");
        });
        const handshake = new WorkspaceCloseHandshake(() => sender);
        await expect(handshake.request("window")).resolves.toBe(false);
        expect(handshake.pending).toBeUndefined();
        expect(sender.listenerCount()).toBe(0);

        const next = handshake.request("window");
        const requestid = handshake.pending!.requestid;
        handshake.respond(sender.id, { requestid, allow: true });
        await expect(next).resolves.toBe(true);
    });

    it.each([null, true, {}, { allow: 1 }, { allow: "true" }])(
        "rejects invalid matching response payload %j",
        async (payload) => {
            const sender = makeSender();
            const handshake = new WorkspaceCloseHandshake(() => sender);
            const result = handshake.request("window");
            const requestid = handshake.pending!.requestid;
            const response = { ...(payload as any), requestid };
            handshake.respond(sender.id, response as any);
            await expect(result).resolves.toBe(false);
        }
    );

    it("retains an allowed preparation until explicit commit or rollback", async () => {
        const sender = makeSender();
        const handshake = new WorkspaceCloseHandshake(() => sender);
        const first = handshake.request("quit");
        const firstId = handshake.pending!.requestid;
        handshake.respond(sender.id, { requestid: firstId, allow: true });
        await expect(first).resolves.toBe(true);
        expect(handshake.prepared?.requestid).toBe(firstId);
        await expect(handshake.request("quit")).resolves.toBe(false);

        handshake.finalize(false);
        expect(sender.send).toHaveBeenLastCalledWith("workspace-close-finalize", {
            requestid: firstId,
            commit: false,
        });
        expect(handshake.prepared).toBeUndefined();
    });
});
