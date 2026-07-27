// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

type SubRecord = {
    eventType: string;
    scope?: string;
    handler: (ev: any) => void;
    active: boolean;
};

const h = vi.hoisted(() => ({
    subs: [] as SubRecord[],
    backfillImpl: null as ((data: any) => Promise<any[]>) | null,
    backfillCalls: [] as any[],
}));

vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: any) => {
        const rec: SubRecord = { eventType: sub.eventType, scope: sub.scope, handler: sub.handler, active: true };
        h.subs.push(rec);
        return () => {
            rec.active = false;
        };
    },
}));

vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: {
        GetCmdBlocksCommand: (_client: any, data: any) => {
            h.backfillCalls.push(data);
            return h.backfillImpl ? h.backfillImpl(data) : Promise.resolve([]);
        },
    },
}));

vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {},
}));

import { globalStore } from "@/app/store/jotaiStore";
import {
    attachCmdRows,
    detachCmdRows,
    lastCommandAtom,
    recentCommandsAtom,
    shellIntegrationSeenAtom,
} from "./cmdblock-rows";

let blockSeq = 0;

function newBlockId(): string {
    return `block-${++blockSeq}`;
}

function activeSubsFor(blockId: string): SubRecord[] {
    return h.subs.filter((s) => s.active && s.scope === `block:${blockId}`);
}

function makeRow(over: Partial<CmdBlock> & { oid: string; seq: number }): CmdBlock {
    return {
        blockid: "unused",
        kind: "shell",
        state: "done",
        promptoffset: 0,
        tspromptns: over.seq * 1000,
        createdat: over.seq * 1000,
        ...over,
    } as CmdBlock;
}

function emitRow(blockId: string, row: CmdBlock) {
    for (const sub of activeSubsFor(blockId)) {
        sub.handler({ event: "cmdblock:row", scopes: [`block:${blockId}`], data: row });
    }
}

beforeEach(() => {
    h.subs.length = 0;
    h.backfillCalls.length = 0;
    h.backfillImpl = null;
});

describe("cmdblock-rows", () => {
    it("subscribes per block and derives recent/last/seen from row events", async () => {
        const blockId = newBlockId();
        attachCmdRows(blockId);

        const subs = activeSubsFor(blockId);
        expect(subs).toHaveLength(1);
        expect(subs[0].eventType).toBe("cmdblock:row");

        expect(globalStore.get(shellIntegrationSeenAtom(blockId))).toBe(false);
        expect(globalStore.get(lastCommandAtom(blockId))).toBe("");

        emitRow(blockId, makeRow({ oid: "a", seq: 1, cmd: "ls" }));
        emitRow(blockId, makeRow({ oid: "b", seq: 2, cmd: "git status" }));
        emitRow(blockId, makeRow({ oid: "c", seq: 3, state: "prompt" }));

        expect(globalStore.get(recentCommandsAtom(blockId))).toEqual(["git status", "ls"]);
        expect(globalStore.get(lastCommandAtom(blockId))).toBe("git status");
        expect(globalStore.get(shellIntegrationSeenAtom(blockId))).toBe(true);

        detachCmdRows(blockId);
    });

    it("collapses state transitions sharing an oid into one entry", () => {
        const blockId = newBlockId();
        attachCmdRows(blockId);

        emitRow(blockId, makeRow({ oid: "a", seq: 1, state: "prompt" }));
        emitRow(blockId, makeRow({ oid: "a", seq: 1, state: "running", cmd: "sleep 5" }));
        emitRow(blockId, makeRow({ oid: "a", seq: 1, state: "done", cmd: "sleep 5", exitcode: 0 }));

        expect(globalStore.get(recentCommandsAtom(blockId))).toEqual(["sleep 5"]);

        detachCmdRows(blockId);
    });

    it("backfills persisted rows under live rows, live winning on oid clashes", async () => {
        const blockId = newBlockId();
        let resolveBackfill: (rows: CmdBlock[]) => void;
        h.backfillImpl = () => new Promise((res) => (resolveBackfill = res));
        attachCmdRows(blockId);
        expect(h.backfillCalls).toEqual([{ blockid: blockId }]);

        emitRow(blockId, makeRow({ oid: "b", seq: 2, state: "done", cmd: "make", exitcode: 0 }));
        resolveBackfill!([
            makeRow({ oid: "a", seq: 1, cmd: "npm ci" }),
            makeRow({ oid: "b", seq: 2, state: "running", cmd: "make" }),
        ]);
        await vi.waitFor(() => {
            expect(globalStore.get(recentCommandsAtom(blockId))).toEqual(["make", "npm ci"]);
        });

        detachCmdRows(blockId);
    });

    it("bounds the ring to the 50 most recent rows", () => {
        const blockId = newBlockId();
        attachCmdRows(blockId);

        for (let i = 1; i <= 60; i++) {
            emitRow(blockId, makeRow({ oid: `oid-${i}`, seq: i, cmd: `cmd-${i}` }));
        }

        const recent = globalStore.get(recentCommandsAtom(blockId));
        expect(recent).toHaveLength(50);
        expect(recent[0]).toBe("cmd-60");
        expect(recent[49]).toBe("cmd-11");

        detachCmdRows(blockId);
    });

    it("keeps one subscription across nested attaches and tears down on the last detach", () => {
        const blockId = newBlockId();
        attachCmdRows(blockId);
        attachCmdRows(blockId);
        expect(activeSubsFor(blockId)).toHaveLength(1);
        expect(h.backfillCalls).toHaveLength(1);

        emitRow(blockId, makeRow({ oid: "a", seq: 1, cmd: "top" }));

        detachCmdRows(blockId);
        expect(activeSubsFor(blockId)).toHaveLength(1);
        expect(globalStore.get(lastCommandAtom(blockId))).toBe("top");

        detachCmdRows(blockId);
        expect(activeSubsFor(blockId)).toHaveLength(0);
        expect(globalStore.get(recentCommandsAtom(blockId))).toEqual([]);
        expect(globalStore.get(shellIntegrationSeenAtom(blockId))).toBe(false);

        detachCmdRows(blockId);
        expect(activeSubsFor(blockId)).toHaveLength(0);
    });

    it("drops a backfill that resolves after the block detached", async () => {
        const blockId = newBlockId();
        let resolveBackfill: (rows: CmdBlock[]) => void;
        h.backfillImpl = () => new Promise((res) => (resolveBackfill = res));
        attachCmdRows(blockId);
        detachCmdRows(blockId);

        resolveBackfill!([makeRow({ oid: "a", seq: 1, cmd: "stale" })]);
        await Promise.resolve();
        await Promise.resolve();

        expect(globalStore.get(recentCommandsAtom(blockId))).toEqual([]);
        expect(globalStore.get(shellIntegrationSeenAtom(blockId))).toBe(false);
    });

    it("resubscribes and re-backfills on re-attach", () => {
        const blockId = newBlockId();
        attachCmdRows(blockId);
        detachCmdRows(blockId);
        attachCmdRows(blockId);

        expect(activeSubsFor(blockId)).toHaveLength(1);
        expect(h.backfillCalls).toHaveLength(2);

        detachCmdRows(blockId);
    });
});
