// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UIcon } from "@/app/element/ui-icon";
import { refocusNode } from "@/app/store/global";
import type { AgentKind } from "@/app/store/tabcmdstate";
import { validateCssColor } from "@/util/color-validator";
import { cn } from "@/util/util";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TabBadges } from "./tabbadges";

const RenameFocusDelayMs = 50;
const LeftFadeGradient = "linear-gradient(to right, transparent 0, black 18px)";

function isPathLike(s: string): boolean {
    return s.includes("/") || s.startsWith("~");
}

// PathText: a single line that left-anchors its text while it fits, and
// scrolls the end into view with a left-edge gradient fade once the content
// would overflow.  We avoid `direction: rtl` — for paths like
// "~/Documents/..." it triggers Unicode bidi reordering (the leading `~` is a
// weak char and can migrate to the end of the visual run).  Instead we keep
// LTR layout and push scrollLeft to the far right when overflowing.
interface PathTextProps {
    text: string;
    className?: string;
    title?: string;
}
const PathText: React.FC<PathTextProps> = ({ text, className, title }) => {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const apply = () => {
            const overflows = el.scrollWidth > el.clientWidth + 1;
            if (overflows) {
                el.scrollLeft = el.scrollWidth - el.clientWidth;
                el.style.setProperty("mask-image", LeftFadeGradient);
                el.style.setProperty("-webkit-mask-image", LeftFadeGradient);
            } else {
                el.scrollLeft = 0;
                el.style.removeProperty("mask-image");
                el.style.removeProperty("-webkit-mask-image");
            }
        };
        apply();
        const ro = new ResizeObserver(apply);
        ro.observe(el);
        return () => ro.disconnect();
    }, [text]);
    return (
        <div
            ref={ref}
            className={cn("overflow-hidden whitespace-nowrap scrollbar-none", className)}
            style={{ overflowX: "scroll", scrollbarWidth: "none" }}
            title={title}
        >
            {text}
        </div>
    );
};
PathText.displayName = "PathText";

export interface VTabItem {
    id: string;
    name: string;
    badge?: Badge | null;
    badges?: Badge[] | null;
    flagColor?: string | null;
    subtitle?: string;
    gitBranch?: string;
    gitAdds?: number;
    gitDels?: number;
    gitChangedFiles?: number;
    runningKind?: AgentKind;
}

interface VTabProps {
    tab: VTabItem;
    active: boolean;
    showDivider?: boolean;
    isDragging: boolean;
    isReordering: boolean;
    hoverResetVersion?: number;
    onSelect: () => void;
    onClose?: () => void;
    onRename?: (newName: string) => void;
    onContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onMoreButtonClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    onDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
    onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragEnd: () => void;
    onHoverChanged?: (isHovered: boolean) => void;
    renameRef?: React.RefObject<(() => void) | null>;
}

// Agent visual treatment.  The brand glyph is shown as a small badge in the
// bottom-right corner of the tab's main icon (vertical-tabs icon-with-
// status pattern).  Color matches each vendor so the status reads at a glance.
const AgentBadgeStyles: Record<
    AgentKind,
    { icon: string; color: string; title: string; spin?: boolean }
> = {
    claude: { icon: "claude", color: "#c0634a", title: "Claude Code running" },
    codex: { icon: "stars-01", color: "#10a37f", title: "Codex running" },
    ai: { icon: "stars-01", color: "var(--color-accent)", title: "AI agent running" },
    generic: { icon: "clock-loader", color: "var(--color-secondary)", title: "Command running", spin: true },
};

function AgentBadge({ kind }: { kind: AgentKind }) {
    const style = AgentBadgeStyles[kind];
    return (
        <span
            className="absolute -bottom-0.5 -right-0.5 flex h-[14px] w-[14px] items-center justify-center rounded-full bg-background ring-1 ring-fg-overlay-3"
            title={style.title}
            aria-label={style.title}
        >
            <UIcon
                name={style.icon}
                size={10}
                className={cn(style.spin && "animate-spin")}
                style={{ color: style.color }}
            />
        </span>
    );
}

function GitStatsBadge({ adds, dels }: { adds?: number; dels?: number }) {
    const hasAdds = adds != null && adds > 0;
    const hasDels = dels != null && dels > 0;
    if (!hasAdds && !hasDels) return null;
    return (
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm bg-fg-overlay-1 px-1.5 py-[1px] text-[10px] font-medium tabular-nums">
            {hasAdds && <span style={{ color: "var(--color-add-strong)" }}>+{adds}</span>}
            {hasDels && <span style={{ color: "var(--color-remove-strong)" }}>−{dels}</span>}
        </span>
    );
}

export function VTab({
    tab,
    active,
    isDragging,
    isReordering,
    hoverResetVersion,
    onSelect,
    onClose,
    onRename,
    onContextMenu,
    onMoreButtonClick,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    onHoverChanged,
    renameRef,
}: VTabProps) {
    const [originalName, setOriginalName] = useState(tab.name);
    const [isEditable, setIsEditable] = useState(false);
    const editableRef = useRef<HTMLDivElement>(null);
    const editableTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const badges = tab.badges ?? (tab.badge ? [tab.badge] : null);

    const rawFlagColor = tab.flagColor;
    let flagColor: string | null = null;
    if (rawFlagColor) {
        try {
            validateCssColor(rawFlagColor);
            flagColor = rawFlagColor;
        } catch {
            flagColor = null;
        }
    }

    useEffect(() => {
        setOriginalName(tab.name);
    }, [tab.name]);

    useEffect(() => {
        return () => {
            if (editableTimeoutRef.current) {
                clearTimeout(editableTimeoutRef.current);
            }
        };
    }, []);

    // When the tab bar bumps hoverResetVersion (e.g. after a drag), notify the
    // parent that hover is clear so stale "hovered" state tied to this row
    // doesn't linger. Purely-CSS :hover self-corrects on the next mousemove.
    useEffect(() => {
        onHoverChanged?.(false);
    }, [hoverResetVersion]);

    const selectEditableText = useCallback(() => {
        if (!editableRef.current) {
            return;
        }
        editableRef.current.focus();
        const range = document.createRange();
        const selection = window.getSelection();
        if (!selection) {
            return;
        }
        range.selectNodeContents(editableRef.current);
        selection.removeAllRanges();
        selection.addRange(range);
    }, []);

    const startRename = useCallback(() => {
        if (onRename == null || isReordering) {
            return;
        }
        if (editableTimeoutRef.current) {
            clearTimeout(editableTimeoutRef.current);
        }
        setIsEditable(true);
        editableTimeoutRef.current = setTimeout(() => {
            selectEditableText();
        }, RenameFocusDelayMs);
    }, [isReordering, onRename, selectEditableText]);

    if (renameRef != null) {
        renameRef.current = startRename;
    }

    const handleBlur = () => {
        if (!editableRef.current) {
            return;
        }
        const newText = editableRef.current.textContent?.trim() || originalName;
        editableRef.current.textContent = newText;
        setIsEditable(false);
        if (newText !== originalName) {
            onRename?.(newText);
        }
        setTimeout(() => refocusNode(null), 10);
    };

    const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
        if (!editableRef.current) {
            return;
        }
        if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            editableRef.current.blur();
            return;
        }
        if (event.key !== "Escape") {
            return;
        }
        editableRef.current.textContent = originalName;
        editableRef.current.blur();
        event.preventDefault();
        event.stopPropagation();
    };

    const applyScrollOnName = isPathLike(tab.name);

    return (
        <div
            draggable
            data-tabid={tab.id}
            onClick={onSelect}
            onDoubleClick={(event) => {
                event.stopPropagation();
                startRename();
            }}
            onContextMenu={onContextMenu}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
            onMouseEnter={() => onHoverChanged?.(true)}
            onMouseLeave={() => onHoverChanged?.(false)}
            className={cn(
                "group relative mx-2 my-0.5 flex shrink-0 cursor-pointer select-none items-start gap-2 rounded px-2 py-2 transition-colors",
                "border",
                active
                    ? "border-fg-overlay-3 bg-fg-overlay-2 text-foreground"
                    : isReordering
                      ? "border-transparent text-secondary"
                      : "border-transparent text-secondary hover:bg-fg-overlay-1 hover:text-foreground",
                isDragging && "opacity-50"
            )}
        >
            {flagColor && (
                <div
                    className="pointer-events-none absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-l"
                    style={{ backgroundColor: flagColor }}
                    aria-hidden
                />
            )}
            <div className="relative flex h-6 w-6 shrink-0 items-center justify-center">
                {badges && badges.length > 0 && !tab.runningKind ? (
                    <TabBadges
                        badges={badges}
                        flagColor={flagColor}
                        className="static top-auto left-auto z-auto m-0 flex h-6 w-6 translate-y-0 items-center justify-center p-0 [&_i]:text-[12px]"
                    />
                ) : (
                    <UIcon name="terminal" size={18} className={active ? "text-foreground" : "text-secondary"} />
                )}
                {tab.runningKind && <AgentBadge kind={tab.runningKind} />}
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-[2px] pt-[1px] pr-1">
                {isEditable || !applyScrollOnName ? (
                    <div
                        ref={editableRef}
                        className={cn(
                            "overflow-hidden whitespace-nowrap text-[12px] leading-tight",
                            !isEditable && "text-ellipsis",
                            isEditable && "rounded-[2px] bg-fg-overlay-3 px-[3px] outline-none"
                        )}
                        contentEditable={isEditable}
                        role="textbox"
                        aria-label="Tab name"
                        aria-readonly={!isEditable}
                        onBlur={handleBlur}
                        onKeyDown={handleKeyDown}
                        suppressContentEditableWarning={true}
                    >
                        {tab.name}
                    </div>
                ) : (
                    <PathText
                        text={tab.name}
                        className="text-[12px] leading-tight"
                        title={tab.name}
                    />
                )}
                <div className="flex min-h-[14px] items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] leading-tight text-sub-text">
                    {tab.subtitle ? (
                        <PathText text={tab.subtitle} className="min-w-0 flex-1" title={tab.subtitle} />
                    ) : null}
                    {tab.gitBranch && (
                        <span className="inline-flex shrink-0 items-center gap-0.5 text-[#b8f2c0]">
                            <UIcon name="git-branch-02" size={11} className="opacity-85" />
                            <span className="max-w-[80px] truncate">{tab.gitBranch}</span>
                        </span>
                    )}
                    <GitStatsBadge adds={tab.gitAdds} dels={tab.gitDels} />
                </div>
            </div>
            {onClose && (
                <div
                    className={cn(
                        "absolute right-1.5 top-1.5 flex h-[20px] items-center gap-[1px] rounded p-[2px]",
                        "border border-white/10 bg-black/45 backdrop-blur-sm",
                        "shadow-[0_1px_3px_rgba(0,0,0,0.4)] transition-opacity duration-100",
                        isReordering
                            ? "pointer-events-none opacity-0"
                            : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
                    )}
                >
                    {(onContextMenu || onMoreButtonClick) && (
                        <button
                            type="button"
                            className="flex h-full w-[18px] cursor-pointer items-center justify-center rounded text-foreground/85 transition-colors hover:bg-fg-overlay-2 hover:text-foreground"
                            onClick={(event) => {
                                event.stopPropagation();
                                if (onMoreButtonClick) {
                                    onMoreButtonClick(event);
                                } else {
                                    onContextMenu!(event as unknown as React.MouseEvent<HTMLDivElement>);
                                }
                            }}
                            aria-label="Tab options"
                            title="Tab options"
                        >
                            <UIcon name="dots-vertical" size={12} />
                        </button>
                    )}
                    <button
                        type="button"
                        className="flex h-full w-[18px] cursor-pointer items-center justify-center rounded text-foreground/85 transition-colors hover:bg-fg-overlay-3 hover:text-foreground"
                        onClick={(event) => {
                            event.stopPropagation();
                            onClose();
                        }}
                        aria-label="Close tab"
                        title="Close tab"
                    >
                        <UIcon name="x-close" size={12} />
                    </button>
                </div>
            )}
        </div>
    );
}
