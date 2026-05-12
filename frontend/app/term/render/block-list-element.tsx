// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// BlockListElement — the scrollable list of blocks.  Mirrors warp's
// `block_list_element.rs` + `block_list_viewport.rs`.
//
// What this owns:
//   1. A scroll container.
//   2. ScrollPosition tracking — "follow-bottom" sticks to the tail of the
//      most recent block; "free" preserves scrollTop while user reads
//      history; "anchored" pins to a specific block (jump-back from a
//      snackbar click).
//   3. Re-pulling the (mutable) block list from TerminalModel on each
//      revision bump.
//
// Virtualization deferred — for typical N=100 blocks DOM scrolls fine.
// Once we hit thousands of blocks we'll wire in the cumulative-heights
// queries that already exist on Blocks.

import { UIcon } from "@/app/element/ui-icon";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FindMatch, TerminalModel } from "../terminal-model";
import { BlockElement } from "./block-element";
import { computeBlockSlice } from "./selection";

const ScrollBottomThresholdPx = 32;
// Jump-to-bottom overhang threshold.  Match warp's choice so the button
// shows up under the same conditions ours does.
// Behavior reference: warp app/src/terminal/view.rs:599
//   JUMP_TO_BOTTOM_OVERHANG_THRESHOLD_PX.
const JumpToBottomOverhangPx = 70;

export interface BlockListElementProps {
    model: TerminalModel;
    fontSize?: number;
    home?: string;
    // Map block.oid → onCopyOutput / onAskAI / etc.  Optional; rendered as
    // toolbelt actions on hover.  Tied here rather than inside BlockElement
    // so the parent owns clipboard / agent dispatch.
    onCopyBlock?: (oid: string) => void;
    onAskAI?: (oid: string) => void;
    onLinkClick?: (uri: string) => void;
    // Pixel width of one monospace cell — TerminalView measures and
    // threads it through.  Used by per-block mouse-to-cell math.
    charWidth?: number;
}

export const BlockListElement = memo(
    ({ model, fontSize = 12, home, onCopyBlock, onAskAI, onLinkClick, charWidth }: BlockListElementProps) => {
        const revision = useAtomValue(model.revisionAtom);
        const scrollPos = useAtomValue(model.scrollPositionAtom);
        const selectedBlockId = useAtomValue(model.selectedBlockIdAtom);
        const selection = useAtomValue(model.selectionAtom);
        const findMatches = useAtomValue(model.findMatchesAtom);
        const findCurrentIndex = useAtomValue(model.findCurrentIndexAtom);
        const snackbarVisible = useAtomValue(model.snackbarVisibleAtom);
        const activeMatch =
            findCurrentIndex >= 0 && findCurrentIndex < findMatches.length
                ? findMatches[findCurrentIndex]
                : null;

        // Group matches by block id once per render so each BlockElement
        // gets only its slice.  Linear over the flat match list — cheap
        // even for hundreds of matches.
        const matchesByBlock = useMemo(() => {
            const map = new Map<string, FindMatch[]>();
            for (const m of findMatches) {
                let arr = map.get(m.blockId);
                if (!arr) {
                    arr = [];
                    map.set(m.blockId, arr);
                }
                arr.push(m);
            }
            return map;
        }, [findMatches]);

        // Precompute the per-block selection slice once.  Each block
        // queries by id; computeBlockSlice handles the cross-block range
        // logic so individual BlockElements stay dumb about block order.
        const blocksRef = model.getBlocks();
        const sliceByBlock = useMemo(() => {
            const map = new Map<string, ReturnType<typeof computeBlockSlice>>();
            if (!selection) return map;
            for (const block of blocksRef.all()) {
                if (block.id === "__sentinel__") continue;
                const slice = computeBlockSlice(selection, block.id, (id) => blocksRef.indexOf(id));
                if (slice) map.set(block.id, slice);
            }
            return map;
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [selection, revision]);

        // Pull the (mutable) blocks snapshot — depends on revision so React
        // re-renders when the engine mutates the collection.
        const blockList = useMemo(() => {
            // The slice is intentional: hand React a stable identity per
            // revision so .map's diff key works as intended.
            return model.getBlocks().all().slice();
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [revision, model]);

        const scrollRef = useRef<HTMLDivElement>(null);
        const lastFollowRevision = useRef<number>(-1);

        // Currently-overhanging block: the block whose top is inside the
        // viewport but whose bottom extends below by more than the
        // threshold.  Drives the floating "jump to bottom" button.
        const [overhangingBlockId, setOverhangingBlockId] = useState<string | null>(null);

        const recomputeOverhang = useCallback(() => {
            const container = scrollRef.current;
            if (!container) {
                setOverhangingBlockId((prev) => (prev == null ? prev : null));
                return;
            }
            const containerRect = container.getBoundingClientRect();
            const blockEls = container.querySelectorAll("[data-block-oid]");
            let found: string | null = null;
            for (const el of Array.from(blockEls) as HTMLElement[]) {
                const r = el.getBoundingClientRect();
                if (
                    r.top < containerRect.bottom &&
                    r.bottom > containerRect.bottom + JumpToBottomOverhangPx
                ) {
                    found = el.dataset.blockOid ?? null;
                    break;
                }
            }
            setOverhangingBlockId((prev) => (prev === found ? prev : found));
        }, []);

        useEffect(() => {
            recomputeOverhang();
            const container = scrollRef.current;
            if (!container) return;
            container.addEventListener("scroll", recomputeOverhang);
            return () => container.removeEventListener("scroll", recomputeOverhang);
        }, [recomputeOverhang]);

        useEffect(() => {
            // Block heights change as output streams in; recompute when
            // the engine bumps revision.  Cheap — bounding-rect reads
            // only.
            recomputeOverhang();
        }, [revision, recomputeOverhang]);

        const handleJumpToBottom = useCallback(() => {
            if (!overhangingBlockId) return;
            const container = scrollRef.current;
            if (!container) return;
            const el = container.querySelector(
                `[data-block-oid="${overhangingBlockId}"]`
            ) as HTMLElement | null;
            el?.scrollIntoView({ block: "end", behavior: "smooth" });
        }, [overhangingBlockId]);

        // Auto-scroll to bottom when in follow-bottom mode and revision bumps.
        // We perform a few deferred scrollTop sets to catch xterm-style
        // multi-frame layout settling — overkill for DOM but cheap insurance.
        useEffect(() => {
            if (scrollPos.kind !== "follow-bottom") return;
            const el = scrollRef.current;
            if (!el) return;
            lastFollowRevision.current = revision;
            const stick = () => {
                el.scrollTop = el.scrollHeight;
            };
            stick();
            const r1 = requestAnimationFrame(stick);
            const r2 = requestAnimationFrame(() => requestAnimationFrame(stick));
            const t = setTimeout(stick, 120);
            return () => {
                cancelAnimationFrame(r1);
                cancelAnimationFrame(r2);
                clearTimeout(t);
            };
        }, [revision, scrollPos.kind]);

        // Anchored mode — scroll a specific block into view.
        useEffect(() => {
            if (scrollPos.kind !== "anchored") return;
            const el = scrollRef.current;
            if (!el) return;
            const child = el.querySelector(`[data-block-oid="${scrollPos.blockId}"]`);
            child?.scrollIntoView({ block: "start", behavior: "smooth" });
        }, [scrollPos]);

        // User scroll → leave follow-bottom mode unless they're at the
        // tail.  warp uses a similar "is at bottom?" check; the threshold
        // gives some slop so a tiny content shift doesn't kick us out.
        const handleScroll = useCallback(() => {
            const el = scrollRef.current;
            if (!el) return;
            const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            const atBottom = distanceFromBottom <= ScrollBottomThresholdPx;
            const current = scrollPos;
            if (atBottom) {
                if (current.kind !== "follow-bottom") {
                    model.setScrollPosition({ kind: "follow-bottom" });
                }
                return;
            }
            // Left the tail — switch to "free" so we don't fight the user.
            if (current.kind !== "free") {
                model.setScrollPosition({ kind: "free", scrollTop: el.scrollTop });
            }
        }, [model, scrollPos]);

        return (
            <div className="relative min-h-0 flex-1">
                <div
                    ref={scrollRef}
                    className="absolute inset-0 overflow-y-auto"
                    onScroll={handleScroll}
                    onClick={(e) => {
                        if (e.target === e.currentTarget) model.clearSelection();
                    }}
                >
                    {blockList.map((block) => {
                        if (block.hidden) return null;
                        if (block.id === "__sentinel__") return null;
                        return (
                            <div key={block.id} data-block-oid={block.id}>
                                <BlockElement
                                    block={block}
                                    revision={revision}
                                    selected={block.id === selectedBlockId}
                                    fontSize={fontSize}
                                    home={home}
                                    onSelect={() => model.selectBlock(block.id)}
                                    onJumpBack={() =>
                                        model.setScrollPosition({ kind: "anchored", blockId: block.id })
                                    }
                                    onLinkClick={onLinkClick}
                                    selectionSlice={sliceByBlock.get(block.id) ?? null}
                                    charWidth={charWidth}
                                    model={model}
                                    findMatches={matchesByBlock.get(block.id)}
                                    activeMatch={activeMatch}
                                    showSnackbar={snackbarVisible}
                                    toolbelt={{
                                        onCopy: onCopyBlock ? () => onCopyBlock(block.id) : undefined,
                                        onAskAI: onAskAI ? () => onAskAI(block.id) : undefined,
                                    }}
                                />
                            </div>
                        );
                    })}
                </div>
                {overhangingBlockId && (
                    <button
                        type="button"
                        onClick={handleJumpToBottom}
                        className="absolute bottom-3 right-3 flex h-7 cursor-pointer items-center gap-1 rounded-full border border-fg-overlay-2 bg-surface-1/95 px-2.5 text-[11px] text-foreground shadow-lg hover:bg-fg-overlay-2"
                        title="Jump to bottom of this block"
                        aria-label="Jump to bottom of this block"
                    >
                        <UIcon name="arrow-down" size={12} />
                        <span>Jump to bottom</span>
                    </button>
                )}
            </div>
        );
    }
);
BlockListElement.displayName = "BlockListElement";
