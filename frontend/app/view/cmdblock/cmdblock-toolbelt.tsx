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
            "flex h-6 w-6 cursor-pointer items-center justify-center rounded transition-colors",
            "text-foreground/85 hover:bg-fg-overlay-3 hover:text-foreground",
            active && "bg-fg-overlay-3 text-foreground",
            danger && "hover:text-rose-400"
        )}
    >
        <UIcon name={icon} size={12} />
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

// CmdBlockToolbelt — hover overlay on the right side of every block.
// A "belt" with a dark transparent backdrop and 1px border that floats inside
// the block header.  Buttons surface on hover via the parent's `group` class.
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
        forceOpen,
    }: CmdBlockToolbeltProps) => (
        <div
            className={cn(
                "flex h-7 items-center gap-[1px] rounded border border-white/10 bg-black/45 p-[2px] backdrop-blur-sm",
                "shadow-[0_1px_3px_rgba(0,0,0,0.4)] transition-opacity duration-100",
                forceOpen
                    ? "opacity-100"
                    : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
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
