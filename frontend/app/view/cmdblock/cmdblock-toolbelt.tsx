// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import { memo } from "react";

interface ToolbeltButtonProps {
    icon: string;
    title: string;
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
    active?: boolean;
    danger?: boolean;
}

const ToolbeltButton = memo(({ icon, title, onClick, active, danger }: ToolbeltButtonProps) => (
    <button
        type="button"
        onClick={(e) => {
            e.stopPropagation();
            onClick(e);
        }}
        title={title}
        aria-label={title}
        className={cn(
            "flex h-5 w-5 cursor-pointer items-center justify-center rounded transition-colors",
            "text-secondary/80 hover:bg-fg-overlay-2 hover:text-foreground",
            active && "bg-fg-overlay-2 text-foreground",
            danger && "hover:text-[var(--color-term-error)]"
        )}
    >
        <UIcon name={icon} size={11} />
    </button>
));
ToolbeltButton.displayName = "ToolbeltButton";

export interface CmdBlockToolbeltProps {
    onMore?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    onAskAI?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    onSaveWorkflow?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    onFilter?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    onBookmark?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    onCopy?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    onShare?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    bookmarked?: boolean;
    filterActive?: boolean;
    className?: string;
    // forceOpen suppresses the group-hover gate.  Used by the snackbar where
    // the toolbelt should always be visible since the row is sticky.
    forceOpen?: boolean;
}

// CmdBlockToolbelt — persistent action icons on the right side of the
// block header.  Visual reference: warp persistent toolbelt visible in
// the dark-theme screenshot (paperclip / download / filter / more-dots).
// Background is transparent — the icons sit directly in the header row
// rather than inside a chip, so they feel part of the prompt strip and
// not a separate UI element.  forceOpen survives as a no-op flag for
// callers that previously toggled hover-only visibility.
export const CmdBlockToolbelt = memo(
    ({
        onMore,
        onAskAI,
        onSaveWorkflow,
        onFilter,
        onBookmark,
        onCopy,
        onShare,
        bookmarked,
        filterActive,
        className,
        forceOpen: _forceOpen,
    }: CmdBlockToolbeltProps) => (
        <div
            className={cn(
                "flex h-5 items-center gap-0.5",
                className
            )}
        >
            {onAskAI && <ToolbeltButton icon="stars-01" title="Ask AI" onClick={onAskAI} />}
            {onCopy && <ToolbeltButton icon="copy" title="Copy output" onClick={onCopy} />}
            {onShare && <ToolbeltButton icon="share-01" title="Share block" onClick={onShare} />}
            {onSaveWorkflow && (
                <ToolbeltButton icon="bookmark" title="Save as workflow" onClick={onSaveWorkflow} />
            )}
            {onFilter && (
                <ToolbeltButton
                    icon={filterActive ? "filter-funnel-filled" : "filter-funnel"}
                    title={filterActive ? "Clear filter" : "Filter output"}
                    onClick={onFilter}
                    active={filterActive}
                />
            )}
            {onBookmark && (
                <ToolbeltButton
                    icon={bookmarked ? "bookmark_filled" : "bookmark"}
                    title={bookmarked ? "Remove bookmark" : "Bookmark"}
                    onClick={onBookmark}
                    active={bookmarked}
                />
            )}
            {onMore && <ToolbeltButton icon="dots-vertical" title="More options" onClick={onMore} />}
        </div>
    )
);
CmdBlockToolbelt.displayName = "CmdBlockToolbelt";
