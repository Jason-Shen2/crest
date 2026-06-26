// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import type { MouseEvent as ReactMouseEvent, ReactNode, Ref } from "react";

export const COMMAND_INLINE_FRAME_CLASSNAME = "border-t border-fg-overlay-2 bg-fg-overlay-1/40 font-sans";
export const COMMAND_INLINE_HEADER_HEIGHT_PX = 36;

export interface CommandInlineFrameProps {
    commandName: string;
    children: ReactNode;
    className?: string;
    headerActions?: ReactNode;
    headerContent?: ReactNode;
    role?: string;
    rootRef?: Ref<HTMLDivElement>;
    onResizeStart?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}

export function CommandInlineFrame({
    commandName,
    children,
    className,
    headerActions,
    headerContent,
    role,
    rootRef,
    onResizeStart,
}: CommandInlineFrameProps) {
    return (
        <div ref={rootRef} className={cn(COMMAND_INLINE_FRAME_CLASSNAME, className)} role={role}>
            <div
                className="relative flex items-center border-b border-fg-overlay-2/60 bg-fg-overlay-1/55 px-3"
                style={{ height: `${COMMAND_INLINE_HEADER_HEIGHT_PX}px` }}
            >
                <div className="flex min-w-0 items-center gap-3">
                    <span
                        className="shrink-0 font-mono uppercase tracking-wider text-foreground/90"
                        style={{ fontSize: "11px" }}
                    >
                        {commandName}
                    </span>
                    {headerContent}
                </div>
                {headerActions && <div className="ml-auto flex shrink-0 items-center gap-0.5">{headerActions}</div>}
                {onResizeStart && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                        <button
                            type="button"
                            onMouseDown={onResizeStart}
                            title="Drag to resize menu height"
                            aria-label={`Resize ${commandName} menu`}
                            data-command-inline-drag-handle="true"
                            className="pointer-events-auto inline-flex shrink-0 cursor-ns-resize items-center justify-center rounded p-1 text-secondary/55 hover:bg-fg-overlay-2/55 hover:text-foreground"
                        >
                            <svg
                                width={20}
                                height={14}
                                viewBox="0 0 24 16"
                                fill="currentColor"
                                display="block"
                                aria-hidden="true"
                            >
                                <circle cx="5" cy="6" r="2" />
                                <circle cx="12" cy="6" r="2" />
                                <circle cx="19" cy="6" r="2" />
                                <circle cx="5" cy="12" r="2" />
                                <circle cx="12" cy="12" r="2" />
                                <circle cx="19" cy="12" r="2" />
                            </svg>
                        </button>
                    </div>
                )}
            </div>
            {children}
        </div>
    );
}
