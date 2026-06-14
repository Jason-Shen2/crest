// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Blocks — the collection of all Blocks for one terminal.  Mirrors warp's
// `terminal/model/blocks.rs`.
//
// The single performance-critical operation is **viewport range queries**:
// given a scroll offset and a viewport height, return the slice of blocks
// that are visible.  warp uses a SumTree<BlockHeightItem> for this — a
// persistent balanced tree where each node sums up the heights below it,
// supporting O(log N) range queries.
//
// In TypeScript we get the same complexity with a *cumulative-height array*:
//
//   cumHeights[i] = sum of heights of list[0..i]
//   cumHeights[N] = total height
//
// Binary search finds the block that straddles a given y-offset in O(log N).
// The only operation that's worse than a SumTree is updateHeight() — we
// have to rewrite cumHeights[i..N] in O(N - i), where SumTree could
// log-update.  In practice, growth happens at the tail (the running block),
// so updateHeight is O(1) amortized.  For random-position updates (rare —
// only when an earlier block re-renders due to filter/hide changes) we eat
// the O(k) cost.  Trading SumTree implementation effort for that is the
// right call.

import { Block } from "./block";
import { AgentBlockRef, BlockId } from "./types";

export interface VisibleRange {
    // First visible block index (inclusive).
    start: number;
    // First not-visible block index past the viewport (exclusive).
    end: number;
    // Pixel-offset of the first visible block's top edge relative to scrollTop.
    // Negative when the block extends above the viewport, zero when aligned.
    offsetY: number;
}

export class Blocks {
    private list: Block[] = [];
    private idIndex: Map<BlockId, number> = new Map();
    // heights[i] = current height contribution of list[i].  Updated by the
    // host (TerminalModel) whenever a block's grid grows or its visibility
    // toggles.  Heights are *logical* (rows, or any unit the renderer
    // chooses) — Blocks doesn't care, it just answers range queries.
    private heights: number[] = [];
    // cumHeights[i] = sum of heights[0..i].  cumHeights[0] = 0.
    // Length = heights.length + 1.
    private cumHeights: number[] = [0];
    // Id of a block kept at the tail across appends — warp's
    // `pinned_to_bottom` (blocks.rs:338). crest pins the live shell prompt
    // (the invisible "waiting-for-input" block, warp's missing_command at
    // block.rs:2026): every append re-floats it to the end, so any new block
    // (agent today; notification / env / AI-suggestion blocks later) lands
    // ABOVE the pending prompt without each call site having to know about
    // it. null = nothing pinned (append goes to the true tail).
    private pinnedToBottomId: BlockId | null = null;

    // ---------- mutation ----------

    push(block: Block, height: number = 0): void {
        const idx = this.list.length;
        this.list.push(block);
        this.idIndex.set(block.id, idx);
        this.heights.push(height);
        this.cumHeights.push(this.cumHeights[idx] + height);
        // Keep the pinned block last (mirrors warp append_rich_content →
        // maintain_pinned_to_bottom, blocks.rs:1037/1058).
        this.maintainPinnedToBottom();
    }

    // Pin a block to the tail (warp's append_rich_content_pinned_to_bottom,
    // blocks.rs:1044). Immediately re-floats it in case blocks already sit
    // after it.
    setPinnedToBottom(id: BlockId): void {
        this.pinnedToBottomId = id;
        this.maintainPinnedToBottom();
    }

    // Release the pin. Pass the id so a stale caller can't clear a newer
    // pin (e.g. the previous prompt clearing after a new one was pinned).
    clearPinnedToBottom(id: BlockId): void {
        if (this.pinnedToBottomId === id) {
            this.pinnedToBottomId = null;
        }
    }

    // Re-float the pinned block to the tail if something was appended after
    // it. Mirrors warp's maintain_pinned_to_bottom: the pin is taken (set to
    // null) during the move so the re-append's own maintain call is a no-op
    // and never recurses (blocks.rs:1058-1090).
    private maintainPinnedToBottom(): void {
        const pinnedId = this.pinnedToBottomId;
        if (pinnedId == null) return;
        const idx = this.idIndex.get(pinnedId);
        if (idx == null || idx === this.list.length - 1) return;
        const height = this.heights[idx];
        this.pinnedToBottomId = null;
        const block = this.removeById(pinnedId);
        if (block) this.push(block, height);
        this.pinnedToBottomId = pinnedId;
    }

    // appendAgentBlock — factory for agent timeline blocks. Mirrors warp's
    // `BlockList::append_item_to_blocklist` (blocks.rs:1074): blocks are
    // added in call order with no timestamp reordering. push() keeps the
    // pinned prompt block last (see pinnedToBottomId), so the agent block
    // correctly lands above the pending prompt with no special-casing here.
    //
    // The returned Block carries an outputGrid + headerGrid for shape
    // uniformity with shell blocks, but neither grid is ever written
    // into (BlockHandler no-ops for kind === "agent"). Rendering goes
    // through AgentBlockElement which looks up the main-owned run by
    // agentRef.runId from usePiChat state.
    //
    // runId is minted by Electron main when it creates the agent run and
    // corresponding timeline row. The block holds it as the only piece of
    // agent state; all message data lives in PaneAgentSession/usePiChat.
    appendAgentBlock(runId: string, height: number = 0, opts?: { id?: BlockId; sessionPath?: string; createdAt?: number }): Block {
        const ref: AgentBlockRef = {
            runId,
            sessionPath: opts?.sessionPath,
            createdAt: opts?.createdAt ?? Date.now(),
        };
        // Use runId as the BlockId core; prefix keeps agent-vs-shell
        // ID origins visually distinguishable in logs / dev tools.
        const blockId = opts?.id ?? `agent_${runId}`;
        const cols = this.list[this.list.length - 1]?.outputGrid?.cols() ?? 80;
        const block = new Block({
            id: blockId,
            seq: this.list.length,
            cols,
            kind: "agent",
            agentRef: ref,
        });
        this.push(block, height);
        return block;
    }

    // Insert a block at a specific position.  Used when a row arrives out of
    // order from the backend (rare — wps events generally preserve order,
    // but the safety net matters).
    insertAt(index: number, block: Block, height: number = 0): void {
        if (index >= this.list.length) {
            this.push(block, height);
            return;
        }
        this.list.splice(index, 0, block);
        this.heights.splice(index, 0, height);
        // Rebuild index map (positions shifted).
        this.rebuildIndex();
        // Rebuild cumHeights from `index` onward.
        this.rebuildCumHeightsFrom(index);
    }

    updateHeight(id: BlockId, nextHeight: number): boolean {
        const idx = this.idIndex.get(id);
        if (idx == null) return false;
        if (this.heights[idx] === nextHeight) return false;
        this.heights[idx] = nextHeight;
        this.rebuildCumHeightsFrom(idx);
        return true;
    }

    setHidden(id: BlockId, hidden: boolean): boolean {
        const block = this.findById(id);
        if (!block) return false;
        if (block.hidden === hidden) return false;
        block.hidden = hidden;
        // When hidden, contribute 0 to total height; cache the previous
        // height on a side-channel so unhiding restores it.  We don't reach
        // into the block for the "real" height because the renderer may
        // re-measure differently after layout changes.
        if (hidden) {
            const idx = this.idIndex.get(id);
            if (idx != null) {
                this.savedHeight.set(id, this.heights[idx]);
                this.heights[idx] = 0;
                this.rebuildCumHeightsFrom(idx);
            }
        } else {
            const saved = this.savedHeight.get(id);
            if (saved != null) {
                const idx = this.idIndex.get(id);
                if (idx != null) {
                    this.heights[idx] = saved;
                    this.savedHeight.delete(id);
                    this.rebuildCumHeightsFrom(idx);
                }
            }
        }
        return true;
    }
    private savedHeight: Map<BlockId, number> = new Map();

    removeAt(index: number): Block | null {
        const removed = this.list[index];
        if (!removed) return null;
        this.list.splice(index, 1);
        this.heights.splice(index, 1);
        this.savedHeight.delete(removed.id);
        this.rebuildIndex();
        this.rebuildCumHeightsFrom(index);
        return removed;
    }

    removeById(id: BlockId): Block | null {
        const idx = this.idIndex.get(id);
        if (idx == null) return null;
        return this.removeAt(idx);
    }

    // truncateBefore — drop all blocks with index < n.  Used by the `clear`
    // command, which hides everything before some sequence number.  warp
    // does the same — see blocks.rs::clear_above.
    truncateBefore(index: number): void {
        if (index <= 0) return;
        for (let i = 0; i < index && this.list.length > 0; i++) {
            this.savedHeight.delete(this.list[0].id);
        }
        this.list.splice(0, index);
        this.heights.splice(0, index);
        this.rebuildIndex();
        this.rebuildCumHeightsFrom(0);
    }

    // ---------- queries ----------

    length(): number {
        return this.list.length;
    }
    totalHeight(): number {
        return this.cumHeights[this.cumHeights.length - 1];
    }
    findById(id: BlockId): Block | undefined {
        const idx = this.idIndex.get(id);
        return idx != null ? this.list[idx] : undefined;
    }
    indexOf(id: BlockId): number {
        return this.idIndex.get(id) ?? -1;
    }
    at(index: number): Block | undefined {
        return this.list[index];
    }
    all(): readonly Block[] {
        return this.list;
    }
    last(): Block | undefined {
        return this.list[this.list.length - 1];
    }

    // visibleRange — O(log N) viewport query.
    //
    // For each block i, its rendered y-range is
    //   [cumHeights[i], cumHeights[i+1])
    //
    // Start: smallest i such that cumHeights[i+1] > scrollTop  (or
    //        equivalently, cumHeights[i] <= scrollTop < cumHeights[i+1]).
    // End:   smallest i such that cumHeights[i] >= scrollTop + viewHeight.
    visibleRange(scrollTop: number, viewHeight: number): VisibleRange {
        const total = this.totalHeight();
        if (this.list.length === 0 || viewHeight <= 0 || scrollTop >= total) {
            return { start: 0, end: 0, offsetY: 0 };
        }
        const bottomY = scrollTop + viewHeight;
        // Binary search for the largest i where cumHeights[i] <= scrollTop.
        const start = upperBoundLE(this.cumHeights, scrollTop, this.list.length);
        // Binary search for the smallest j where cumHeights[j] >= bottomY.
        const end = lowerBoundGE(this.cumHeights, bottomY, this.list.length + 1);
        return {
            start,
            end: Math.max(end, start + 1),
            offsetY: this.cumHeights[start] - scrollTop,
        };
    }

    // cumulativeTop — y-coordinate of block[index]'s top edge.  Used to
    // implement "scroll to block" jump-back.
    cumulativeTop(index: number): number {
        if (index < 0) return 0;
        if (index >= this.cumHeights.length) return this.totalHeight();
        return this.cumHeights[index];
    }

    // ---------- internal ----------

    private rebuildIndex(): void {
        this.idIndex.clear();
        for (let i = 0; i < this.list.length; i++) {
            this.idIndex.set(this.list[i].id, i);
        }
    }

    private rebuildCumHeightsFrom(start: number): void {
        // Ensure cumHeights has length list.length + 1.
        this.cumHeights.length = this.list.length + 1;
        if (start <= 0) this.cumHeights[0] = 0;
        for (let i = Math.max(start, 0); i < this.list.length; i++) {
            this.cumHeights[i + 1] = this.cumHeights[i] + this.heights[i];
        }
    }
}

// ---------- binary-search helpers ----------

// upperBoundLE — largest index i in [0, n) where arr[i] <= target.
// Returns 0 when target < arr[0].  arr is assumed sorted ascending and
// arr.length >= n + 1 (so arr[n] is the sentinel total).
function upperBoundLE(arr: number[], target: number, n: number): number {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid + 1] > target) hi = mid;
        else lo = mid + 1;
    }
    return Math.min(lo, n - 1);
}

// lowerBoundGE — smallest index i in [0, n) where arr[i] >= target.
// Returns n when no such index exists.
function lowerBoundGE(arr: number[], target: number, n: number): number {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
