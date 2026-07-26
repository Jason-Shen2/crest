// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Per-block command-rows store (docs/terax-terminal-port.md §四 P2.6).
// Subscribes to cmdblock:row wps events scoped to a single block, keeps a
// bounded ring of the most recent rows, and derives the agent/context data
// feeds that used to come from the deleted TerminalModel: recent commands,
// last command, and whether shell integration has produced any data.
//
// Consumers hold atoms obtained via recentCommandsAtom / lastCommandAtom /
// shellIntegrationSeenAtom; data only flows while at least one owner has
// called attachCmdRows (refcounted — view models attach in their
// constructor and detach in dispose()).

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as jotai from "jotai";

const MaxRows = 50;

export interface CmdRowEntry {
    oid: string;
    seq: number;
    cmd: string;
    exitcode?: number;
    state: string;
    durationms?: number;
    // Row creation time in nanoseconds (CmdBlock.createdat).
    ts: number;
}

interface BlockCmdRows {
    refCount: number;
    // Bumped on every subscribe/unsubscribe so an in-flight backfill can
    // detect it outlived its attachment and drop its result.
    generation: number;
    unsubscribe: (() => void) | null;
    rowsAtom: jotai.PrimitiveAtom<CmdRowEntry[]>;
    seenAtom: jotai.PrimitiveAtom<boolean>;
    recentCmdsAtom: jotai.Atom<string[]>;
    lastCmdAtom: jotai.Atom<string>;
}

// Entries are never deleted so atom references handed to consumers stay
// stable across attach/detach cycles; block ids are UUIDs, so the map is
// bounded by the number of blocks seen in this renderer's lifetime.
const blockEntries = new Map<string, BlockCmdRows>();

function getEntry(blockId: string): BlockCmdRows {
    const existing = blockEntries.get(blockId);
    if (existing) return existing;
    const rowsAtom = jotai.atom<CmdRowEntry[]>([]) as jotai.PrimitiveAtom<CmdRowEntry[]>;
    const seenAtom = jotai.atom(false) as jotai.PrimitiveAtom<boolean>;
    const entry: BlockCmdRows = {
        refCount: 0,
        generation: 0,
        unsubscribe: null,
        rowsAtom,
        seenAtom,
        recentCmdsAtom: jotai.atom((get) => {
            const cmds: string[] = [];
            const rows = get(rowsAtom);
            for (let i = rows.length - 1; i >= 0; i--) {
                if (rows[i].cmd) {
                    cmds.push(rows[i].cmd);
                }
            }
            return cmds;
        }),
        lastCmdAtom: jotai.atom((get) => {
            const rows = get(rowsAtom);
            for (let i = rows.length - 1; i >= 0; i--) {
                if (rows[i].cmd) {
                    return rows[i].cmd;
                }
            }
            return "";
        }),
    };
    blockEntries.set(blockId, entry);
    return entry;
}

function toEntryRow(row: CmdBlock): CmdRowEntry {
    return {
        oid: row.oid,
        seq: row.seq,
        cmd: row.cmd ?? "",
        exitcode: row.exitcode,
        state: row.state,
        durationms: row.durationms,
        ts: row.createdat,
    };
}

// A single command produces multiple cmdblock:row events (prompt → running →
// done share one oid), so updates replace in place; only new oids append.
function upsertRow(rows: CmdRowEntry[], row: CmdRowEntry): CmdRowEntry[] {
    const idx = rows.findIndex((r) => r.oid === row.oid);
    if (idx >= 0) {
        const next = rows.slice();
        next[idx] = row;
        return next;
    }
    const next = [...rows, row];
    if (next.length > MaxRows) {
        next.splice(0, next.length - MaxRows);
    }
    return next;
}

function handleRow(entry: BlockCmdRows, row: CmdBlock) {
    if (!row?.oid) return;
    globalStore.set(entry.rowsAtom, upsertRow(globalStore.get(entry.rowsAtom), toEntryRow(row)));
    globalStore.set(entry.seenAtom, true);
}

async function backfill(blockId: string, entry: BlockCmdRows, generation: number) {
    let persisted: CmdBlock[];
    try {
        // GetCmdBlocksCommand's limit selects the *oldest* N rows (the Go
        // side is ORDER BY seq ASC LIMIT), so it can't express "most recent
        // 50" — fetch all and slice client-side instead.
        persisted = await RpcApi.GetCmdBlocksCommand(TabRpcClient, { blockid: blockId });
    } catch (e) {
        console.warn("cmdblock-rows: backfill failed", blockId, e);
        return;
    }
    if (entry.generation !== generation || entry.refCount === 0) return;
    if (persisted == null || persisted.length === 0) return;
    let rows = persisted.slice(-MaxRows).map(toEntryRow);
    // Live rows that arrived while the fetch was in flight are newer than
    // their persisted copies, so they're re-applied on top.
    for (const liveRow of globalStore.get(entry.rowsAtom)) {
        rows = upsertRow(rows, liveRow);
    }
    rows.sort((a, b) => a.seq - b.seq);
    globalStore.set(entry.rowsAtom, rows);
    globalStore.set(entry.seenAtom, true);
}

export function attachCmdRows(blockId: string): void {
    const entry = getEntry(blockId);
    entry.refCount++;
    if (entry.refCount > 1) return;
    entry.generation++;
    entry.unsubscribe = waveEventSubscribeSingle({
        eventType: "cmdblock:row",
        scope: `block:${blockId}`,
        handler: (ev) => handleRow(entry, ev.data as CmdBlock),
    });
    void backfill(blockId, entry, entry.generation);
}

export function detachCmdRows(blockId: string): void {
    const entry = blockEntries.get(blockId);
    if (entry == null || entry.refCount === 0) return;
    entry.refCount--;
    if (entry.refCount > 0) return;
    entry.generation++;
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    globalStore.set(entry.rowsAtom, []);
    globalStore.set(entry.seenAtom, false);
}

export function recentCommandsAtom(blockId: string): jotai.Atom<string[]> {
    return getEntry(blockId).recentCmdsAtom;
}

export function lastCommandAtom(blockId: string): jotai.Atom<string> {
    return getEntry(blockId).lastCmdAtom;
}

export function shellIntegrationSeenAtom(blockId: string): jotai.Atom<boolean> {
    return getEntry(blockId).seenAtom;
}
