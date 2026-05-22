// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// ResizeHandle — mirrors warp's `Resizable` widget with DragBarSide::Right.
// One thin column on the inner edge of a side panel; pointerdown captures
// the document, pointermove emits clamped widths, pointerup releases.
//
// Why a custom handle instead of react-resizable-panels:
//   * RRP works in percentages; warp stores widths in px (resizable_data.rs
//     :16, drive/panel.rs:38–39).  Round-tripping px↔% accumulated drift
//     and the library's async `onLayout` fought our sync `setLayout()`.
//   * Toggling visibility via `Panel.collapse()` raced with our
//     `defaultSize`/`setLayout()` updates, producing the visible jitter
//     the user described as "very unstable".
//
// This handle does only one thing: while dragged, emit clamped widths to
// the parent's `onResize`.  Visibility (panel rendered or not) is handled
// upstream by simply omitting the panel + handle from the flex row, just
// like warp's `render_panels` skips the `LeftPanelView` when
// `pane_group.left_panel_open == false`.

import { cn } from "@/util/util";
import { memo, useCallback, useEffect, useRef } from "react";

export interface ResizeHandleProps {
    // Current panel width in px (the value we're dragging away from).
    width: number;
    // Hard clamp.  warp: drive/panel.rs:38 MIN_SIDEBAR_WIDTH = 250.
    min: number;
    // Soft clamp evaluated *each* pointermove so a window resize mid-drag
    // updates the upper bound (warp's `with_bounds_callback` recomputes
    // `window_size.x() * MAX_SIDEBAR_WIDTH_RATIO` on every paint).
    maxFn: () => number;
    // Called with the new px width on every move (live preview).  Should
    // be cheap — the parent stores the value in a jotai atom and the
    // panel re-renders at its new width.
    onResize: (next: number) => void;
    // Called once on pointerup with the final clamped width.  Use this to
    // persist (warp writes to ResizableData / WindowSnapshot here).
    onResizeEnd?: (final: number) => void;
    // Drag direction.  "right" = handle sits on the right edge of a
    // left-side panel and drags east to grow.  "left" = right-side panel,
    // drag west to grow.  Mirrors warp's DragBarSide.
    side?: "right" | "left";
    className?: string;
}

export const ResizeHandle = memo(
    ({ width, min, maxFn, onResize, onResizeEnd, side = "right", className }: ResizeHandleProps) => {
        const draggingRef = useRef(false);
        // Snapshot start state in refs so the document-level listeners
        // (which close over their first definition) always see fresh values.
        const startXRef = useRef(0);
        const startWidthRef = useRef(0);
        const latestRef = useRef(width);

        // Keep `latestRef` synced with the prop so when a drag *starts*,
        // we begin from the currently-rendered width — not a stale closure.
        useEffect(() => {
            latestRef.current = width;
        }, [width]);

        const onPointerDown = useCallback(
            (e: React.PointerEvent<HTMLDivElement>) => {
                // Left button only; right/middle pass through so context
                // menus on the divider still work if added later.
                if (e.button !== 0) return;
                e.preventDefault();
                draggingRef.current = true;
                startXRef.current = e.clientX;
                startWidthRef.current = latestRef.current;

                const onMove = (ev: PointerEvent) => {
                    if (!draggingRef.current) return;
                    const dx = ev.clientX - startXRef.current;
                    const delta = side === "right" ? dx : -dx;
                    const max = maxFn();
                    const clamped = Math.max(min, Math.min(max, startWidthRef.current + delta));
                    latestRef.current = clamped;
                    onResize(clamped);
                };
                const onUp = () => {
                    if (!draggingRef.current) return;
                    draggingRef.current = false;
                    document.removeEventListener("pointermove", onMove);
                    document.removeEventListener("pointerup", onUp);
                    document.removeEventListener("pointercancel", onUp);
                    // Restore body cursor / select.
                    document.body.style.removeProperty("cursor");
                    document.body.style.removeProperty("user-select");
                    onResizeEnd?.(latestRef.current);
                };
                // Capture the cursor + suppress selection while dragging so
                // the pointer doesn't flicker between col-resize and text
                // I-beam as it passes over other elements.
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
                document.addEventListener("pointermove", onMove);
                document.addEventListener("pointerup", onUp);
                document.addEventListener("pointercancel", onUp);
            },
            [min, maxFn, onResize, onResizeEnd, side]
        );

        return (
            <div
                onPointerDown={onPointerDown}
                role="separator"
                aria-orientation="vertical"
                className={cn(
                    "shrink-0 w-0.5 cursor-col-resize bg-transparent hover:bg-zinc-500/30 transition-colors",
                    className
                )}
            />
        );
    }
);
ResizeHandle.displayName = "ResizeHandle";
