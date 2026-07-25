// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import {
    useCallback,
    useEffect,
    useRef,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
    type Ref,
    type RefObject,
} from "react";

export const COMMAND_INLINE_FRAME_CLASSNAME =
    "overflow-hidden rounded-2xl border border-white/[0.12] bg-[rgba(34,34,36,0.62)] font-sans text-foreground shadow-[0_10px_32px_-24px_rgba(0,0,0,0.65)] backdrop-blur-2xl backdrop-saturate-150";
export const COMMAND_INLINE_HEADER_HEIGHT_PX = 44;

export interface CommandInlineFrameProps {
    commandName: string;
    children: ReactNode;
    className?: string;
    dismissAnchorRef?: RefObject<HTMLElement | null>;
    headerActions?: ReactNode;
    headerContent?: ReactNode;
    onDismiss?: () => void;
    dismissOnEscape?: boolean;
    role?: string;
    rootRef?: Ref<HTMLDivElement>;
    onResizeStart?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
}

type CommandInlineContainmentTarget = {
    contains(node: Node): boolean;
};

export function shouldDismissCommandInlineFramePointerDown(
    root: CommandInlineContainmentTarget | null | undefined,
    anchor: CommandInlineContainmentTarget | null | undefined,
    target: Node | null
): boolean {
    if (!target) return false;
    if (root?.contains(target)) return false;
    if (anchor?.contains(target)) return false;
    return true;
}

export function isCommandInlineFrameDismissKey(key: string): boolean {
    return key === "Escape";
}

function assignCommandInlineFrameRef(ref: Ref<HTMLDivElement> | undefined, value: HTMLDivElement | null) {
    if (!ref) return;
    if (typeof ref === "function") {
        ref(value);
        return;
    }
    (ref as { current: HTMLDivElement | null }).current = value;
}

export function CommandInlineFrame({
    commandName,
    children,
    className,
    dismissAnchorRef,
    headerActions,
    headerContent,
    onDismiss,
    dismissOnEscape = true,
    role,
    rootRef,
    onResizeStart,
}: CommandInlineFrameProps) {
    const localRootRef = useRef<HTMLDivElement | null>(null);
    const setRootRef = useCallback(
        (value: HTMLDivElement | null) => {
            localRootRef.current = value;
            assignCommandInlineFrameRef(rootRef, value);
        },
        [rootRef]
    );

    useEffect(() => {
        if (!onDismiss) return;

        const handlePointerDown = (event: MouseEvent) => {
            if (
                shouldDismissCommandInlineFramePointerDown(
                    localRootRef.current,
                    dismissAnchorRef?.current,
                    event.target as Node | null
                )
            ) {
                onDismiss();
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (!dismissOnEscape) return;
            if (!isCommandInlineFrameDismissKey(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
        };

        document.addEventListener("mousedown", handlePointerDown, true);
        window.addEventListener("keydown", handleKeyDown, true);
        return () => {
            document.removeEventListener("mousedown", handlePointerDown, true);
            window.removeEventListener("keydown", handleKeyDown, true);
        };
    }, [dismissAnchorRef, dismissOnEscape, onDismiss]);

    return (
        <div ref={setRootRef} className={cn(COMMAND_INLINE_FRAME_CLASSNAME, className)} role={role}>
            <div
                className="flex items-center border-b border-white/[0.07] bg-white/[0.035] px-4"
                style={{ height: `${COMMAND_INLINE_HEADER_HEIGHT_PX}px` }}
            >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span
                        className="shrink-0 font-mono uppercase tracking-wider text-accent"
                        style={{ fontSize: "11px" }}
                    >
                        {commandName}
                    </span>
                    {headerContent}
                    {onResizeStart && (
                        <button
                            type="button"
                            onMouseDown={onResizeStart}
                            title="Drag to resize menu height"
                            aria-label={`Resize ${commandName} menu`}
                            data-command-inline-drag-handle="true"
                            className="inline-flex shrink-0 cursor-ns-resize items-center justify-center rounded-lg p-1 text-secondary/55 hover:bg-fg-overlay-2/55 hover:text-foreground"
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
                    )}
                </div>
                <div className="ml-auto flex min-w-0 items-center gap-0.5">{headerActions}</div>
            </div>
            {children}
        </div>
    );
}
