// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import { memo, useEffect, useRef, useState } from "react";
import { CmdBlockHeader, CmdBlockHeaderProps } from "./cmdblock-header";
import { CmdBlockToolbelt, CmdBlockToolbeltProps } from "./cmdblock-toolbelt";

export interface CmdBlockSnackbarProps extends Omit<CmdBlockHeaderProps, "rightSlot"> {
    // The element whose visibility we anchor against.  When the user
    // scrolls past it, the snackbar pins to the top of the viewport so the
    // command line stays readable while reading long output.
    anchorRef: React.RefObject<HTMLElement | null>;
    toolbelt?: CmdBlockToolbeltProps;
    onJumpBack?: () => void;
    // Hide the snackbar terminal-wide.  When set, renders a small "✕"
    // chip on the right side of the bar.  Re-enable through the
    // keyboard shortcut Cmd/Ctrl+Shift+S or via a settings panel.
    onDismiss?: () => void;
}

// CmdBlockSnackbar — sticky pinned header.  Renders as a sticky strip at
// the top of the parent block while the command's body extends below.
// Visibility is driven by an IntersectionObserver on `anchorRef` so the
// snackbar only shows while the original header has scrolled out of view.
export const CmdBlockSnackbar = memo(
    ({ anchorRef, toolbelt, onJumpBack, onDismiss, ...headerProps }: CmdBlockSnackbarProps) => {
        const [pinned, setPinned] = useState(false);
        const containerRef = useRef<HTMLDivElement>(null);

        useEffect(() => {
            const el = anchorRef.current;
            if (!el) return;
            const observer = new IntersectionObserver(
                ([entry]) => {
                    setPinned(!entry.isIntersecting && entry.boundingClientRect.top < 0);
                },
                { rootMargin: "0px 0px 0px 0px", threshold: 0 }
            );
            observer.observe(el);
            return () => observer.disconnect();
        }, [anchorRef]);

        if (!pinned) return null;

        return (
            <div
                ref={containerRef}
                className={cn(
                    "sticky top-0 z-10 flex items-stretch border-b border-fg-overlay-2 bg-background/95 backdrop-blur-md",
                    "shadow-[0_2px_6px_rgba(0,0,0,0.35)]"
                )}
                onClick={(e) => {
                    e.stopPropagation();
                    onJumpBack?.();
                }}
            >
                <CmdBlockHeader
                    {...headerProps}
                    rightSlot={
                        <div className="ml-1 flex items-center">
                            {toolbelt && <CmdBlockToolbelt {...toolbelt} forceOpen />}
                            {onDismiss && (
                                <button
                                    type="button"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDismiss();
                                    }}
                                    className="ml-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded text-secondary hover:bg-fg-overlay-2 hover:text-foreground"
                                    aria-label="Hide command bar"
                                    title="Hide command bar (Cmd/Ctrl+Shift+S)"
                                >
                                    <UIcon name="x-close" size={11} />
                                </button>
                            )}
                        </div>
                    }
                />
            </div>
        );
    }
);
CmdBlockSnackbar.displayName = "CmdBlockSnackbar";
