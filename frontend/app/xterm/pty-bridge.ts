// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getFileSubject } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { base64ToArray, stringToBase64 } from "@/util/util";

export type PtyHandlers = {
    onData: (bytes: Uint8Array, offset?: number) => void;
    onTruncate?: () => void;
    onShellExit?: () => void;
};

export type PtySession = {
    blockId: string;
    write: (data: string) => Promise<void>;
    resize: (cols: number, rows: number) => Promise<void>;
    kick: (cols: number, rows: number) => Promise<void>;
    dispose: () => void;
};

export function attachPty(blockId: string, handlers: PtyHandlers): PtySession {
    const fileSubject = getFileSubject(blockId, "term");
    const dataSub = fileSubject.subscribe((event) => {
        if (event.fileop === "append") {
            handlers.onData(base64ToArray(event.data64), event.offset);
            return;
        }
        if (event.fileop === "truncate") {
            handlers.onTruncate?.();
        }
    });

    const resize = async (cols: number, rows: number): Promise<void> => {
        await RpcApi.ControllerInputCommand(TabRpcClient, {
            blockid: blockId,
            termsize: { rows, cols },
        });
    };

    let disposed = false;

    return {
        blockId,
        write: async (data: string): Promise<void> => {
            await RpcApi.ControllerInputCommand(TabRpcClient, {
                blockid: blockId,
                inputdata64: stringToBase64(data),
            });
        },
        resize,
        kick: async (cols: number, rows: number): Promise<void> => {
            if (cols <= 0 || rows <= 0) {
                return;
            }
            // Linux only emits SIGWINCH when the winsize ioctl actually
            // changes dims, so bump +1 row then restore. The TUI receives
            // (possibly two) SIGWINCHes and repaints from scratch.
            await resize(cols, rows + 1);
            await resize(cols, rows);
        },
        dispose: () => {
            if (disposed) {
                return;
            }
            disposed = true;
            dataSub.unsubscribe();
            fileSubject.release();
        },
    };
}
