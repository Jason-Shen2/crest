// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Subject } from "rxjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    getFileSubject: vi.fn(),
}));

vi.mock("@/app/store/wps", () => ({
    getFileSubject: mocks.getFileSubject,
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {},
}));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        ControllerInputCommand: vi.fn().mockResolvedValue(undefined),
    },
}));

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { stringToBase64 } from "@/util/util";

import { attachPty, type PtyHandlers } from "./pty-bridge";

function makeFileSubject(): SubjectWithRef<WSFileEventData> {
    const subject = new Subject<WSFileEventData>() as SubjectWithRef<WSFileEventData>;
    subject.refCount = 1;
    subject.release = vi.fn();
    return subject;
}

function makeFileEvent(fileop: string, data64 = ""): WSFileEventData {
    return { zoneid: "block-1", filename: "term", fileop, data64 };
}

describe("attachPty", () => {
    let fileSubject: SubjectWithRef<WSFileEventData>;
    let handlers: { onData: ReturnType<typeof vi.fn>; onTruncate: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        vi.clearAllMocks();
        fileSubject = makeFileSubject();
        mocks.getFileSubject.mockReturnValue(fileSubject);
        handlers = { onData: vi.fn(), onTruncate: vi.fn() };
    });

    it("subscribes to the term blockfile subject for the block", () => {
        const session = attachPty("block-1", handlers);
        expect(mocks.getFileSubject).toHaveBeenCalledWith("block-1", "term");
        expect(session.blockId).toBe("block-1");
        expect(fileSubject.observed).toBe(true);
    });

    it("decodes append events and forwards bytes to onData", () => {
        attachPty("block-1", handlers);
        fileSubject.next(makeFileEvent("append", stringToBase64("hello")));
        expect(handlers.onData).toHaveBeenCalledTimes(1);
        const bytes = handlers.onData.mock.calls[0][0] as Uint8Array;
        expect(bytes).toBeInstanceOf(Uint8Array);
        expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111]);
        expect(handlers.onTruncate).not.toHaveBeenCalled();
    });

    it("forwards truncate events to onTruncate", () => {
        attachPty("block-1", handlers);
        fileSubject.next(makeFileEvent("truncate"));
        expect(handlers.onTruncate).toHaveBeenCalledTimes(1);
        expect(handlers.onData).not.toHaveBeenCalled();
    });

    it("tolerates a missing onTruncate handler", () => {
        const bare: PtyHandlers = { onData: vi.fn() };
        attachPty("block-1", bare);
        expect(() => fileSubject.next(makeFileEvent("truncate"))).not.toThrow();
    });

    it("ignores unrelated fileops", () => {
        attachPty("block-1", handlers);
        fileSubject.next(makeFileEvent("invalidate"));
        expect(handlers.onData).not.toHaveBeenCalled();
        expect(handlers.onTruncate).not.toHaveBeenCalled();
    });

    it("write sends base64-encoded input via ControllerInputCommand", async () => {
        const session = attachPty("block-1", handlers);
        await session.write("ls -la\r");
        expect(RpcApi.ControllerInputCommand).toHaveBeenCalledTimes(1);
        expect(RpcApi.ControllerInputCommand).toHaveBeenCalledWith(TabRpcClient, {
            blockid: "block-1",
            inputdata64: stringToBase64("ls -la\r"),
        });
    });

    it("resize sends termsize via ControllerInputCommand", async () => {
        const session = attachPty("block-1", handlers);
        await session.resize(120, 40);
        expect(RpcApi.ControllerInputCommand).toHaveBeenCalledTimes(1);
        expect(RpcApi.ControllerInputCommand).toHaveBeenCalledWith(TabRpcClient, {
            blockid: "block-1",
            termsize: { rows: 40, cols: 120 },
        });
    });

    it("kick resizes to rows+1 then back, sequentially", async () => {
        const resolved: string[] = [];
        vi.mocked(RpcApi.ControllerInputCommand).mockImplementation(async (_client, data) => {
            resolved.push(`rows=${data.termsize.rows}`);
        });
        const session = attachPty("block-1", handlers);
        await session.kick(80, 24);
        expect(resolved).toEqual(["rows=25", "rows=24"]);
        expect(RpcApi.ControllerInputCommand).toHaveBeenNthCalledWith(1, TabRpcClient, {
            blockid: "block-1",
            termsize: { rows: 25, cols: 80 },
        });
        expect(RpcApi.ControllerInputCommand).toHaveBeenNthCalledWith(2, TabRpcClient, {
            blockid: "block-1",
            termsize: { rows: 24, cols: 80 },
        });
    });

    it("kick ignores non-positive dimensions", async () => {
        const session = attachPty("block-1", handlers);
        await session.kick(0, 24);
        await session.kick(80, 0);
        expect(RpcApi.ControllerInputCommand).not.toHaveBeenCalled();
    });

    it("dispose unsubscribes and releases the file subject", () => {
        const session = attachPty("block-1", handlers);
        session.dispose();
        expect(fileSubject.observed).toBe(false);
        expect(fileSubject.release).toHaveBeenCalledTimes(1);
        fileSubject.next(makeFileEvent("append", stringToBase64("late")));
        expect(handlers.onData).not.toHaveBeenCalled();
    });

    it("dispose is idempotent", () => {
        const session = attachPty("block-1", handlers);
        session.dispose();
        session.dispose();
        expect(fileSubject.release).toHaveBeenCalledTimes(1);
    });
});
