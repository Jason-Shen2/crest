// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// BlockElement — one command block in the list.  Composes:
//
//   ┌────────────────────────────────────────┐
//   │ [snackbar: pinned when scrolled past] │  (CmdBlockSnackbar, optional)
//   ├────────────────────────────────────────┤
//   │ prompt-row: cwd / branch / cmd / icon │  (CmdBlockHeader)
//   │  + hover-toolbelt on the right        │  (CmdBlockToolbelt)
//   ├────────────────────────────────────────┤
//   │  output_grid rendered as DOM rows     │  (GridElement)
//   │  — or alt-screen if active            │
//   │  + cursor overlay (running / TUI)     │
//   │  + selection layer                    │
//   └────────────────────────────────────────┘
//
// Mouse handling:
//   * Selection (drag inside the grid host) is the default behavior.
//   * When the TUI has enabled a mouse reporting mode (DEC 1000/1002/1003
//     + 1006/1015), mousedown/move/up/wheel encode into the wire format
//     and route to the PTY instead of starting selection.  The selection
//     path still fires when the user holds Shift (modifier convention:
//     "shift-click overrides mouse capture") so they can copy text even
//     while a TUI eats clicks.

import { cn } from "@/util/util";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { CmdBlockHeader } from "@/app/view/cmdblock/cmdblock-header";
import { CmdBlockSnackbar } from "@/app/view/cmdblock/cmdblock-snackbar";
import { CmdBlockToolbelt, CmdBlockToolbeltProps } from "@/app/view/cmdblock/cmdblock-toolbelt";
import { blockStateFromRaw } from "@/app/view/cmdblock/cmdblock-status";
import { Block } from "../engine/block";
import { mouseReportingActive } from "../engine/types";
import { TerminalModel } from "../terminal-model";
import { FindMatch } from "../terminal-model";
import { BlockContextMenu, BlockContextMenuEntry } from "./block-context-menu";
import { CursorOverlay } from "./cursor-overlay";
import { FindHighlightLayer } from "./find-highlight-layer";

// Auto-collapse head/tail row counts.  Pure crest values — see the
// note next to the row threshold in terminal-model.ts for why crest
// auto-collapses at all (warp doesn't; it relies on GPU rendering to
// handle large blocks without DOM cost).  Numbers picked to keep one
// terminal-screen-worth of context at each end.
const CollapseHeadRows = 30;
const CollapseTailRows = 20;
import { GridElement } from "./grid-element";
import { LogicalMouseEvent, MouseButton, encodeMouseEvent, shouldReportAction } from "./mouse";
import { BlockSelectionSlice, SelectionMode, pixelToCell } from "./selection";
import { SelectionLayer } from "./selection-layer";
import { blockIsActiveTuiSurface, terminalCaptureActive } from "./tui-capture";

type MouseLikeEvent = Pick<
    React.MouseEvent<HTMLDivElement>,
    "clientX" | "clientY" | "shiftKey" | "altKey" | "ctrlKey" | "preventDefault" | "stopPropagation"
>;

function hasVisibleCursorAnchor(grid: import("../engine/grid").Grid): boolean {
    const row = grid.getRow(grid.cursor.row);
    const maxCol = Math.min(grid.cursor.col, row.length - 1);
    for (let col = 0; col <= maxCol; col++) {
        const cell = row[col];
        if (!cell) continue;
        if (cell.width !== 0 && cell.char.length > 0) return true;
    }
    return false;
}

export interface BlockElementProps {
    block: Block;
    revision: number;
    selected?: boolean;
    fontSize?: number;
    onSelect?: () => void;
    onJumpBack?: () => void;
    onLinkClick?: (uri: string) => void;
    toolbelt?: CmdBlockToolbeltProps;
    home?: string;
    showSnackbar?: boolean;
    // Per-block slice of the global selection (or null if this block
    // isn't in the selected range).  Computed by BlockListElement from
    // the model's selection atom + block order.
    selectionSlice?: BlockSelectionSlice | null;
    charWidth?: number;
    // Optional — wires terminal-wide mode access (mouse reporting modes)
    // and PTY writes (mouse byte encoding).  Without it, only selection
    // fires on mouse events and the cursor never renders.
    model?: TerminalModel;
    // Find matches scoped to this block.  Layer paints rectangles over
    // every range; `activeMatch` (compared by reference) gets a stronger
    // outline as the prev/next focus indicator.
    findMatches?: FindMatch[];
    activeMatch?: FindMatch | null;
}

export const BlockElement = memo(
    ({
        block,
        revision,
        selected,
        fontSize,
        onSelect,
        onJumpBack,
        onLinkClick,
        toolbelt,
        home,
        showSnackbar = true,
        selectionSlice,
        charWidth,
        model,
        findMatches,
        activeMatch,
    }: BlockElementProps) => {
        const headerAnchorRef = useRef<HTMLDivElement>(null);
        const gridHostRef = useRef<HTMLDivElement>(null);
        // Track which mouse buttons are pressed so we can correctly tag
        // motion events as "drag" vs free-move under mode 1002.
        const buttonDownRef = useRef<MouseButton | null>(null);
        const lastMouseCellRef = useRef<{ row: number; col: number } | null>(null);

        // Duration tick — while the command is running, force a re-render
        // once per second so the elapsed-time readout in the header stays
        // live.  Stops when the block transitions out of "running".
        const [, setDurationTick] = useState(0);
        useEffect(() => {
            if (block.state !== "running") return;
            const id = setInterval(() => setDurationTick((t) => t + 1), 1000);
            return () => clearInterval(id);
        }, [block.state]);

        // Right-click context menu position.  Fixed-coord (viewport) so it
        // isn't clipped by overflow ancestors.  Null = closed.
        const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);

        const visualState = mapLifecycleToVisual(block);

        const inAltScreen = block.altScreen.active;
        const activeTuiSurface = blockIsActiveTuiSurface(block, model?.getMode());
        const cmd = block.commandText() || undefined;
        // Frozen alt-screen — after a TUI exits we keep its last frame
        // visible if no post-exit output has landed, so vim/htop/less
        // sessions don't visually vanish from the block list.
        const outputRowCount = block.outputGrid.rowCount();
        const frozenAltScreen =
            !inAltScreen && block.altScreen.wasActive && outputRowCount === 0;
        const showAltScreen = inAltScreen || frozenAltScreen;
        const liveGrid = showAltScreen ? block.altScreen.grid : block.outputGrid.raw();
        const forceCursorVisible =
            activeTuiSurface &&
            block.state === "running" &&
            !block.altScreen.active &&
            !terminalCaptureActive(model?.getMode()) &&
            hasVisibleCursorAnchor(liveGrid);
        const lineHeight = Math.round((fontSize ?? 12) * 1.4);
        const effCharWidth = charWidth ?? (fontSize ?? 12) * 0.6;

        // Collapsed view: render the first HeadRows and last TailRows with
        // an elision bar in between.  Auto-disabled while find has matches
        // in this block (so users can see what they're searching for) and
        // when an alt-screen surface is shown (TUI paints a fixed surface).
        const hasFindMatches = (findMatches?.length ?? 0) > 0;
        const showCollapsed =
            !showAltScreen &&
            block.collapsed &&
            outputRowCount > CollapseHeadRows + CollapseTailRows &&
            !hasFindMatches;
        const hiddenCount = showCollapsed
            ? outputRowCount - CollapseHeadRows - CollapseTailRows
            : 0;

        // Render the cursor for blocks that are actually receiving input —
        // running blocks (the shell prompt's cursor sits in the output grid)
        // and any alt-screen TUI.  Done blocks have no live cursor.
        const showCursor = block.state === "running" || inAltScreen;

        const cellFromEvent = useCallback(
            (e: MouseLikeEvent): { row: number; col: number } | null => {
                const host = gridHostRef.current;
                if (!host) return null;
                const rect = host.getBoundingClientRect();
                const relX = e.clientX - rect.left;
                const relY = e.clientY - rect.top;
                if (relY < 0 || relY > rect.height + lineHeight) return null;
                return pixelToCell(relX, relY, effCharWidth, lineHeight, liveGrid);
            },
            [effCharWidth, lineHeight, liveGrid]
        );

        // mouseButtonFromDom — translate `MouseEvent.button` (0=left,
        // 1=middle, 2=right) into our logical button label.
        const mouseButtonFromDom = (n: number): MouseButton | null => {
            switch (n) {
                case 0:
                    return "left";
                case 1:
                    return "middle";
                case 2:
                    return "right";
                default:
                    return null;
            }
        };

        const forwardMouse = useCallback(
            (
                e: MouseLikeEvent,
                action: "press" | "release" | "motion",
                button: MouseButton
            ): boolean => {
                if (!model) return false;
                const mode = model.getMode();
                if (!mouseReportingActive(mode)) return false;
                const dragging = action === "motion" && buttonDownRef.current != null;
                if (!shouldReportAction(action, dragging, mode)) return false;
                const eventCell = cellFromEvent(e);
                if (eventCell) {
                    lastMouseCellRef.current = eventCell;
                }
                const cell = eventCell ?? (action === "release" ? lastMouseCellRef.current : null);
                if (!cell) return false;
                const logical: LogicalMouseEvent = {
                    button,
                    row: cell.row,
                    col: cell.col,
                    action,
                    shift: e.shiftKey,
                    alt: e.altKey,
                    ctrl: e.ctrlKey,
                };
                const bytes = encodeMouseEvent(logical, mode);
                if (bytes == null) return false;
                e.preventDefault();
                e.stopPropagation();
                void model.sendBytes(bytes);
                return true;
            },
            [cellFromEvent, model]
        );

        useEffect(() => {
            const onMouseUp = (e: MouseEvent) => {
                if (!buttonDownRef.current) return;
                forwardMouse(e, "release", buttonDownRef.current);
                buttonDownRef.current = null;
                lastMouseCellRef.current = null;
            };
            document.addEventListener("mouseup", onMouseUp);
            window.addEventListener("mouseup", onMouseUp);
            return () => {
                document.removeEventListener("mouseup", onMouseUp);
                window.removeEventListener("mouseup", onMouseUp);
            };
        }, [forwardMouse]);

        const handleMouseDown = useCallback(
            (e: React.MouseEvent<HTMLDivElement>) => {
                const button = mouseButtonFromDom(e.button);
                if (!button) return;
                // Shift or Alt overrides TUI mouse capture — the user is
                // making a selection (Shift = char selection / extend,
                // Alt = rectangular / column selection).  Without these,
                // mouse-capture mode forwards to PTY.
                if (model && !e.shiftKey && !e.altKey) {
                    const mode = model.getMode();
                    if (mouseReportingActive(mode)) {
                        buttonDownRef.current = button;
                        forwardMouse(e, "press", button);
                        return;
                    }
                }
                if (!model) return;
                if (button !== "left") return;
                const cell = cellFromEvent(e);
                if (!cell) return;
                // Mode resolution: Alt wins over click-count (rectangular
                // selection on Alt+drag is the standard terminal idiom).
                // Otherwise e.detail counts consecutive clicks within the
                // browser's double-click interval: 2 = word, 3+ = line.
                let selectionMode: SelectionMode = "char";
                if (e.altKey) selectionMode = "block";
                else if (e.detail === 2) selectionMode = "word";
                else if (e.detail >= 3) selectionMode = "line";
                model.beginSelection(block.id, cell.row, cell.col, selectionMode);
            },
            [block.id, cellFromEvent, forwardMouse, model]
        );

        const handleMouseMove = useCallback(
            (e: React.MouseEvent<HTMLDivElement>) => {
                // PTY mouse forwarding takes priority while a button is held
                // in capture mode.  We use the recorded button rather than
                // the event's (which is always 0 for motion).
                if (buttonDownRef.current) {
                    forwardMouse(e, "motion", buttonDownRef.current);
                    return;
                }
                // Mode 1003 reports motion without a button; encoder uses
                // button code 3 for the "no button" case.
                if (model && !e.shiftKey) {
                    const mode = model.getMode();
                    if (mode.mouseMotion) {
                        forwardMouse(e, "motion", "none");
                        return;
                    }
                }
                if (!model || !model.isDraggingSelection()) return;
                const cell = cellFromEvent(e);
                if (!cell) return;
                model.extendSelection(block.id, cell.row, cell.col);
            },
            [block.id, cellFromEvent, forwardMouse, model]
        );

        const handleMouseUp = useCallback(
            (e: React.MouseEvent<HTMLDivElement>) => {
                if (buttonDownRef.current) {
                    forwardMouse(e, "release", buttonDownRef.current);
                    buttonDownRef.current = null;
                    lastMouseCellRef.current = null;
                    return;
                }
                // Selection drag end is also handled by the document-level
                // mouseup listener in TerminalView (so releases outside any
                // block still finalize).  Calling here is idempotent.
                model?.endSelection();
            },
            [forwardMouse, model]
        );

        const handleMouseLeave = useCallback(() => {
            // Don't end the selection drag here — the user may be
            // mid-drag across blocks and pointer transitions trigger
            // mouseleave/mouseenter rapidly.  Keep PTY-mouse capture too
            // so a release after re-entering still reaches the TUI.
        }, []);

        const handleWheel = useCallback(
            (e: React.WheelEvent<HTMLDivElement>) => {
                if (!model) return;
                const mode = model.getMode();
                if (!mouseReportingActive(mode)) return;
                const button: MouseButton = e.deltaY < 0 ? "wheelUp" : "wheelDown";
                const cell = cellFromEvent(e as unknown as React.MouseEvent<HTMLDivElement>);
                if (!cell) return;
                const logical: LogicalMouseEvent = {
                    button,
                    row: cell.row,
                    col: cell.col,
                    action: "press",
                    shift: e.shiftKey,
                    alt: e.altKey,
                    ctrl: e.ctrlKey,
                };
                const bytes = encodeMouseEvent(logical, mode);
                if (bytes == null) return;
                e.preventDefault();
                e.stopPropagation();
                void model.sendBytes(bytes);
            },
            [cellFromEvent, model]
        );

        const handleContextMenu = useCallback(
            (e: React.MouseEvent<HTMLDivElement>) => {
                // Right-click in TUI mouse-capture mode goes to the PTY,
                // not the in-app context menu.
                if (model) {
                    const mode = model.getMode();
                    if (mouseReportingActive(mode)) {
                        e.preventDefault();
                        return;
                    }
                }
                e.preventDefault();
                setMenuPos({ x: e.clientX, y: e.clientY });
            },
            [model]
        );

        const menuItems: BlockContextMenuEntry[] = (() => {
            // Menu structure mirrors warp's block context menu grouping
            // (copy / navigate / extra), with crest-specific additions
            // (Re-run, Collapse) at the end.
            // Behavior reference: warp app/src/terminal/view.rs:15490-15700,
            // app/src/terminal/view/init.rs:600-625 for label wording.
            const cmdText = block.commandText();
            const outText = gridToText(liveGrid);
            const items: BlockContextMenuEntry[] = [];

            // --- Group 1: Copy ---
            if (cmdText) {
                items.push({
                    label: "Copy command",
                    onClick: () => void navigator.clipboard.writeText(cmdText),
                });
            }
            items.push({
                label: "Copy output",
                onClick: () => void navigator.clipboard.writeText(outText),
                disabled: outText.length === 0,
            });
            if (cmdText) {
                items.push({
                    label: "Copy command and output",
                    onClick: () => void navigator.clipboard.writeText(`${cmdText}\n${outText}`),
                });
            }

            // --- Group 2: Navigate ---
            items.push({ separator: true });
            if (onJumpBack) {
                items.push({
                    label: "Scroll to top of block",
                    onClick: onJumpBack,
                });
            }
            items.push({
                label: "Scroll to bottom of block",
                onClick: () => {
                    const el = document.querySelector(`[data-block-oid="${block.id}"]`);
                    el?.scrollIntoView({ block: "end", behavior: "smooth" });
                },
            });

            // --- Group 3: Crest extras + AI ---
            items.push({ separator: true });
            if (model && cmdText) {
                // Crest divergence from warp: Re-run is a one-click way
                // to reissue the captured command.  Warp lacks this in
                // the block context menu (they have a separate workflow).
                items.push({
                    label: "Re-run command",
                    onClick: () => void model.submitInput(cmdText),
                });
            }
            if (model && !inAltScreen && outputRowCount > CollapseHeadRows + CollapseTailRows) {
                items.push({
                    label: block.collapsed ? "Expand output" : "Collapse output",
                    onClick: () => model.toggleBlockCollapsed(block.id),
                });
            }
            if (toolbelt?.onAskAI) {
                // toolbelt.onAskAI is typed for a React click event because
                // it's also bound to the toolbelt <button>.  Wrappers from
                // BlockListElement ignore the event arg, so calling with
                // none is safe.
                const askAI = toolbelt.onAskAI as unknown as () => void;
                items.push({
                    label: "Ask AI",
                    onClick: () => askAI(),
                });
            }
            return items;
        })();

        // Block frame visual rules — mirror warp's draw_block_background /
        // draw_border_between_blocks (block_list_element.rs:2358-2459):
        //   • 1px bottom divider in theme.outline() (= our `border` token)
        //     between consecutive blocks.
        //   • Failed blocks: 10% red tint over the whole block + a 4-5px
        //     red left flag-pole (LEFT_STRIPE_WIDTH = 5, warpify/render.rs:39).
        //   • Selected blocks: stronger fg-overlay-2 fill + accent left
        //     stripe so selection still reads even with the red tint.
        // The flag-pole is rendered as a border-l-4 on the wrapper so it
        // automatically clips to block bounds when scrolling.
        const isFailed =
            block.state === "done-with-execution" &&
            block.exitCode != null &&
            block.exitCode !== 0;
        return (
            <div
                onClick={onSelect}
                className={cn(
                    // 1px bottom border between blocks — warp
                    // draw_border_between_blocks (block_list_element.rs:
                    // 2454-2459) paints in `theme.outline()`, which
                    // resolves to fg_overlay_2 = white×10% (color.rs:154
                    // + :546).  No left flag-pole (per user feedback the
                    // left stripe looked bad); failure is shown via the red
                    // background tint + the exit code in the header.
                    "group relative border-b border-fg-overlay-2 transition-colors",
                    // Selection: subtle 10% accent fill, no border — per
                    // user feedback, warp's full 25% + 2px outline reads
                    // too aggressive in crest's layout.  Keeps the
                    // selection discoverable via the tint alone.
                    selected && "bg-[var(--color-term-accent-10)]",
                    // Failed (non-selected): 10% red overlay (warp
                    // block_list_element.rs:2404-2410, bg = failed × 10%).
                    isFailed && !selected && "bg-[var(--ansi-red)]/10",
                    activeTuiSurface && "h-full min-h-full"
                )}
            >
                {showSnackbar && !activeTuiSurface && (
                    <CmdBlockSnackbar
                        anchorRef={headerAnchorRef}
                        state={visualState}
                        cwd={block.pwd}
                        home={home}
                        branch={block.gitBranch}
                        cmd={cmd}
                        durationMs={block.durationMs()}
                        exitCode={block.exitCode}
                        toolbelt={toolbelt}
                        onJumpBack={onJumpBack}
                        onDismiss={model ? () => model.setSnackbarVisible(false) : undefined}
                    />
                )}
                {!activeTuiSurface && (
                    <div ref={headerAnchorRef}>
                        <CmdBlockHeader
                            state={visualState}
                            cwd={block.pwd}
                            home={home}
                            branch={block.gitBranch}
                            cmd={cmd}
                            durationMs={block.durationMs()}
                            exitCode={block.exitCode}
                            selected={selected}
                            venv={block.virtualEnv}
                            nodeVersion={block.nodeVersion}
                            rightSlot={
                                toolbelt ? <CmdBlockToolbelt {...toolbelt} /> : undefined
                            }
                        />
                    </div>
                )}
                {/* Per user feedback: no visible gap between the command
                    row and its output — the two share one continuous
                    background.  Drop padding_middle (warp 0.5 lines) to
                    0 so the first stdout row sits flush under the command
                    line.  Keep a small pb-2 (≈ 8 px, half of warp's 1.0
                    line) so the next block's top divider doesn't kiss
                    this block's last line. */}
                <div
                    className={cn(
                        activeTuiSurface ? "h-full min-h-full p-0" : "px-3 pt-0 pb-2"
                    )}
                >
                    <div
                        ref={gridHostRef}
                        // Layout padding sits on the outer div so this inner
                        // host has zero padding — its border box equals the
                        // text content box.  SelectionLayer / FindHighlight /
                        // CursorOverlay all position absolute inside it, and
                        // cellFromEvent uses getBoundingClientRect() of this
                        // same node, so mouse-to-cell math and layer rect
                        // math share a single origin.
                        //
                        // select-none suppresses the browser's native text
                        // selection so it doesn't draw a second highlight on
                        // top of SelectionLayer.  Copy goes through our
                        // Cmd+C handler (model.copySelection), so disabling
                        // native selection has no copy-path consequence.
                        className={cn(
                            "relative select-none",
                            activeTuiSurface && "h-full min-h-full"
                        )}
                        onMouseDown={handleMouseDown}
                        onMouseMove={handleMouseMove}
                        onMouseUp={handleMouseUp}
                        onMouseLeave={handleMouseLeave}
                        onWheel={handleWheel}
                        onContextMenu={handleContextMenu}
                    >
                        {showAltScreen ? (
                            <GridElement
                                source={block.altScreen.grid}
                                revision={revision}
                                fontSize={fontSize}
                                className={cn(
                                    activeTuiSurface && "min-h-full",
                                    frozenAltScreen ? "text-foreground/85" : "text-foreground"
                                )}
                                onLinkClick={onLinkClick}
                            />
                        ) : showCollapsed ? (
                            <>
                                <GridElement
                                    source={block.outputGrid}
                                    revision={revision}
                                    fontSize={fontSize}
                                    className={cn(activeTuiSurface && "min-h-full", "text-foreground")}
                                    onLinkClick={onLinkClick}
                                    visibleRowIndicesOverride={Array.from(
                                        { length: CollapseHeadRows },
                                        (_, i) => i
                                    )}
                                />
                                <button
                                    type="button"
                                    onClick={() => model?.toggleBlockCollapsed(block.id)}
                                    className="my-1 flex w-full cursor-pointer items-center justify-center gap-2 rounded border border-dashed border-fg-overlay-2 bg-fg-overlay-1/40 px-3 py-1 text-[11px] text-secondary hover:bg-fg-overlay-1 hover:text-foreground"
                                    title="Click to expand"
                                >
                                    ─── {hiddenCount} rows hidden — click to expand ───
                                </button>
                                <GridElement
                                    source={block.outputGrid}
                                    revision={revision}
                                    fontSize={fontSize}
                                    className={cn(activeTuiSurface && "min-h-full", "text-foreground")}
                                    onLinkClick={onLinkClick}
                                    visibleRowIndicesOverride={Array.from(
                                        { length: CollapseTailRows },
                                        (_, i) => outputRowCount - CollapseTailRows + i
                                    )}
                                />
                            </>
                        ) : (
                            <GridElement
                                source={block.outputGrid}
                                revision={revision}
                                fontSize={fontSize}
                                className={cn(activeTuiSurface && "min-h-full", "text-foreground")}
                                onLinkClick={onLinkClick}
                            />
                        )}
                        {showCursor && !showCollapsed && (
                            <CursorOverlay
                                grid={liveGrid}
                                charWidth={effCharWidth}
                                lineHeight={lineHeight}
                                revision={revision}
                                forceVisible={forceCursorVisible}
                            />
                        )}
                        {findMatches && findMatches.length > 0 && !showCollapsed && (
                            <FindHighlightLayer
                                matches={findMatches}
                                activeMatch={activeMatch ?? null}
                                charWidth={effCharWidth}
                                lineHeight={lineHeight}
                            />
                        )}
                        {!showCollapsed && (
                            <SelectionLayer
                                slice={selectionSlice ?? null}
                                grid={liveGrid}
                                charWidth={effCharWidth}
                                lineHeight={lineHeight}
                            />
                        )}
                    </div>
                </div>
                {menuPos && menuItems.length > 0 && (
                    <BlockContextMenu
                        x={menuPos.x}
                        y={menuPos.y}
                        items={menuItems}
                        onClose={() => setMenuPos(null)}
                    />
                )}
            </div>
        );
    }
);
BlockElement.displayName = "BlockElement";

// gridToText — flatten a grid into a plain-text string for clipboard
// operations.  Trailing whitespace per row is trimmed; entirely-blank
// trailing rows are dropped so a `ls` of a 10-row directory doesn't
// drag 30 empty rows of allocation into the paste buffer.
function gridToText(grid: import("../engine/grid").Grid): string {
    const lines: string[] = [];
    let lastNonblank = -1;
    for (let r = 0; r < grid.rowCount(); r++) {
        const row = grid.getRow(r);
        let s = "";
        for (const cell of row) {
            if (!cell) continue;
            if (cell.width === 0) continue;
            s += cell.char.length > 0 ? cell.char : " ";
        }
        const trimmed = s.replace(/\s+$/g, "");
        if (trimmed.length > 0) lastNonblank = r;
        lines.push(trimmed);
    }
    if (lastNonblank < 0) return "";
    return lines.slice(0, lastNonblank + 1).join("\n");
}

function mapLifecycleToVisual(block: Block):
    | "before"
    | "running"
    | "done-ok"
    | "done-err"
    | "background"
    | "static" {
    if (block.state === "background") return "background";
    if (block.state === "static") return "static";
    if (block.state === "running") return "running";
    if (block.state === "waiting-for-input" || block.state === "done-with-no-execution") return "before";
    return blockStateFromRaw("done", block.exitCode);
}
