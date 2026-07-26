// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// XtermPaneModel — per-block thin model carrying the external contracts that
// survive TerminalModel's removal (docs/terax-terminal-port.md §四 P1.6):
// the agent surface writes user-facing messages into `notificationAtom`, and
// focus requests funnel through `focusRequestAtom`. Everything else the old
// TerminalModel owned lives in xterm-session.ts / renderer-pool.ts now.
// agent-surface / assistant-ui keep reading TerminalModel until the engine
// deletion step rewires them here.

import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";

export class XtermPaneModel {
    readonly blockId: string;
    readonly notificationAtom = jotai.atom("") as jotai.PrimitiveAtom<string>;
    readonly focusRequestAtom = jotai.atom(0) as jotai.PrimitiveAtom<number>;

    constructor(blockId: string) {
        this.blockId = blockId;
    }

    requestFocus(): void {
        globalStore.set(this.focusRequestAtom, (prev) => prev + 1);
    }
}

const paneModels = new Map<string, XtermPaneModel>();

export function getXtermPaneModel(blockId: string): XtermPaneModel {
    const existing = paneModels.get(blockId);
    if (existing) return existing;
    const model = new XtermPaneModel(blockId);
    paneModels.set(blockId, model);
    return model;
}

export function disposeXtermPaneModel(blockId: string): void {
    paneModels.delete(blockId);
}
