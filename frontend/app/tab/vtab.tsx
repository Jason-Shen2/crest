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
    // Second-line content.  In Expanded mode this gets its own row at
    // 12px; in Compact mode it's the 10px subtitle (optional).
    subtitle?: string;
    // Third-line content (Expanded mode only).  Mirrors warp's
    // `MetadataLeftContent` — when Pane-title-as is Command or
    // WorkingDirectory the left of the metadata row shows the git
    // branch; when it's Branch, it shows the working directory.
    metadataLeftKind?: "branch" | "workingdir";
    metadataLeftValue?: string;
    // Right-side metadata (Expanded mode only).
    gitAdds?: number;
    gitDels?: number;
    gitChangedFiles?: number;
    // Legacy field — kept so existing call sites that only render a
    // branch chip on the second-line metadata still compile.  When
    // metadataLeftKind is set, this is ignored.
    gitBranch?: string;
    runningKind?: AgentKind;
    // Optional icon override.  Tab rows always render the terminal
    // glyph (or a TabBadges cluster); pane rows pick an icon based on
    // their block's view type (term, preview, web, etc.).
    iconName?: string;
}

interface VTabProps {
    tab: VTabItem;
    active: boolean;
    viewMode?: "compact" | "expanded";
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
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm bg-fg-overlay-1 px-1.5 py-[1px] text-[12px] font-medium tabular-nums">
            {hasAdds && <span style={{ color: "var(--color-add-strong)" }}>+{adds}</span>}
            {hasDels && <span style={{ color: "var(--color-remove-strong)" }}>−{dels}</span>}
        </span>
    );
}

export function VTab({
    tab,
    active,
    viewMode = "expanded",
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
    const isCompact = viewMode === "compact";
    // Resolve metadata-left for the third row (Expanded only).
    const hasMetadataLeft = !!(tab.metadataLeftKind && tab.metadataLeftValue);
    const hasGitStats =
        (tab.gitAdds ?? 0) > 0 || (tab.gitDels ?? 0) > 0 || (tab.gitChangedFiles ?? 0) > 0;
    const showMetadataRow = !isCompact && (hasMetadataLeft || hasGitStats);
    const [isLocalHovered, setIsLocalHovered] = useState(false);

    // Warp `pane_row_background` (vertical_tabs.rs 272-293):
    // - If the tab has a user-chosen color, the row background IS that
    //   color — 15% opacity at rest, 50% on hover or when selected.
    //   No left-edge stripe; the whole card tints.
    // - Otherwise the row falls back to `fg_overlay_2` (selected) or
    //   `fg_overlay_1` (hover/drag-target), or no background at all.
    // TAB_COLOR_OPACITY = 15, TAB_COLOR_HOVER_OPACITY = 50 (vertical_tabs.rs 107-108).
    let inlineBg: string | undefined;
    if (flagColor) {
        const opacityPct = active || isLocalHovered ? 50 : 15;
        inlineBg = `color-mix(in srgb, ${flagColor} ${opacityPct}%, transparent)`;
    }

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
            onMouseEnter={() => {
                setIsLocalHovered(true);
                onHoverChanged?.(true);
            }}
            onMouseLeave={() => {
                setIsLocalHovered(false);
                onHoverChanged?.(false);
            }}
            style={{ backgroundColor: inlineBg }}
            // Warp `render_pane_row_element` (vertical_tabs.rs 295-357):
            // - 4px corner radius, 1px border (transparent when not selected)
            // - Padding::uniform(8.) — 8px all around
            // - Selected: fg_overlay_2 bg + fg_overlay_3 border (or color tint above)
            // - Hover (non-selected): fg_overlay_1 bg, NO border tint
            // - Title color stays main_text_color in all states; only the
            //   background changes when the row is selected.  Crucially we
            //   keep `text-foreground` on inactive rows too — dimming the
            //   title for non-selected rows makes the whole panel look
            //   washed out compared to warp.
            className={cn(
                "group relative mx-2 my-0.5 flex shrink-0 cursor-pointer select-none rounded transition-[background-color,border-color] duration-75",
                "border text-foreground items-start gap-2 px-2 py-2",
                // Warp uses `Padding::uniform(8.)` for BOTH compact and
                // expanded (`render_pane_row_element`).  The visual
                // diff between modes is purely the subtitle font size
                // and the absence/presence of the metadata row — NOT
                // padding or layout direction.  Both modes use a top-
                // aligned icon + text column.
                flagColor
                    ? active
                        ? "border-fg-overlay-3"
                        : "border-transparent"
                    : active
                      ? "border-fg-overlay-3 bg-fg-overlay-2"
                      : isReordering
                        ? "border-transparent"
                        : "border-transparent hover:bg-fg-overlay-1",
                isDragging && "opacity-50"
            )}
        >
            {/* No flag-color stripe — warp `pane_row_background`
                tints the whole row background (handled via the
                style prop above), there's no left-edge accent rail. */}
            <div className="relative flex h-6 w-6 shrink-0 items-center justify-center">
                {badges && badges.length > 0 && !tab.runningKind ? (
                    <TabBadges
                        badges={badges}
                        flagColor={flagColor}
                        className="static top-auto left-auto z-auto m-0 flex h-6 w-6 translate-y-0 items-center justify-center p-0 [&_i]:text-[15px]"
                    />
                ) : (
                    // Warp neutral icons use NEUTRAL_GLYPH_RATIO = 16/24
                    // — a 16px glyph centered in a 24px container —
                    // identical between compact and expanded.  Icon color
                    // is theme.sub_text in both states; selection only
                    // changes the row background, never the glyph color.
                    <UIcon
                        name={tab.iconName ?? "terminal"}
                        size={16}
                        className="text-secondary"
                    />
                )}
                {tab.runningKind && <AgentBadge kind={tab.runningKind} />}
            </div>
            <div
                className={cn(
                    "flex min-w-0 flex-1 flex-col pr-1 pt-[1px]",
                    // Warp Expanded uses 2px between lines
                    // (`with_margin_top(2.)` in render_terminal_row_content);
                    // Compact uses 1px (`with_spacing(1.)` in
                    // render_compact_pane_row).
                    isCompact ? "gap-[1px]" : "gap-[2px]"
                )}
            >
                {/* Line 1 — title @ 12px, identical in both modes. */}
                {isEditable || !applyScrollOnName ? (
                    <div
                        ref={editableRef}
                        className={cn(
                            "overflow-hidden whitespace-nowrap text-[13px] leading-tight",
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
                    <PathText text={tab.name} className="text-[13px] leading-tight" title={tab.name} />
                )}

                {/* Line 2 — subtitle.  Compact: 10px sub_text; Expanded:
                    12px sub_text (warp `render_text_line` default).
                    Hidden when there's nothing to show. */}
                {tab.subtitle && (
                    <PathText
                        text={tab.subtitle}
                        className={cn(
                            "leading-tight text-sub-text",
                            isCompact ? "text-[12px]" : "text-[13px]"
                        )}
                        title={tab.subtitle}
                    />
                )}

                {/* Line 3 — metadata row (Expanded only, terminal-style).
                    Left: branch or working-dir per primaryInfo.
                    Right: diff stats badge (gated by showDiffStats up-stream).
                    Fixed height so toggling stats doesn't resize the row
                    (warp `METADATA_ROW_HEIGHT = BADGE_ICON_SIZE + 2`). */}
                {showMetadataRow && (
                    <div className="flex h-[14px] items-center justify-between gap-2 overflow-hidden text-[12px] leading-tight text-sub-text">
                        <div className="min-w-0 flex-1 overflow-hidden">
                            {tab.metadataLeftKind === "branch" && tab.metadataLeftValue && (
                                <span className="inline-flex max-w-full items-center gap-0.5 text-[#b8f2c0]">
                                    <UIcon name="git-branch-02" size={10} className="opacity-85" />
                                    <span className="truncate">{tab.metadataLeftValue}</span>
                                </span>
                            )}
                            {tab.metadataLeftKind === "workingdir" && tab.metadataLeftValue && (
                                <PathText
                                    text={tab.metadataLeftValue}
                                    className="block max-w-full text-[12px] text-sub-text"
                                    title={tab.metadataLeftValue}
                                />
                            )}
                        </div>
                        <GitStatsBadge adds={tab.gitAdds} dels={tab.gitDels} />
                    </div>
                )}
            </div>
            {onClose && (
                // Warp "belt" action group — direct port of
                // `render_group_action_buttons` (vertical_tabs.rs:2186-2260)
                // with the positioning from the Stack overlay at
                // vertical_tabs.rs:2103-2110:
                //   ParentAnchor::TopRight, ChildAnchor::TopRight
                //   offset = vec2f(-4., GROUP_HEADER_VERTICAL_PADDING /*=4*/)
                //   → belt's top-right sits 4px from row's top, 4px from right edge.
                //
                // Constants:
                //   GROUP_ACTION_BUTTON_ICON_SIZE = 12   (12px icons)
                //   GROUP_ACTION_BUTTON_PADDING   = 2    (2px padding,
                //                                        applied both around the belt
                //                                        and inside each button)
                //   GROUP_ACTION_BUTTON_GAP       = 2    (2px between buttons)
                //   ROW_CORNER_RADIUS / belt radius = 4
                //
                // Color tokens:
                //   belt bg  = internal_colors::neutral_3 (= bg.blend(fg@15%) — opaque)
                //   belt brd = internal_colors::neutral_4 (= bg.blend(fg@20%) — opaque)
                //   icon col = sub_text_color
                //   kebab hover bg = fg_overlay_2
                //   close hover bg = fg_overlay_3
                //
                // We compute neutral_3 / neutral_4 via CSS `color-mix`
                // against crest's existing --color-background and
                // --color-foreground vars so the belt stays theme-correct
                // without hardcoding hex values.
                <div
                    className={cn(
                        "absolute top-1 right-1 flex items-center gap-[2px] rounded-[4px] border p-[2px]",
                        "transition-opacity duration-100",
                        isReordering
                            ? "pointer-events-none opacity-0"
                            : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"
                    )}
                    style={{
                        backgroundColor:
                            "color-mix(in srgb, var(--color-background) 85%, var(--color-foreground) 15%)",
                        borderColor:
                            "color-mix(in srgb, var(--color-background) 80%, var(--color-foreground) 20%)",
                    }}
                >
                    {(onContextMenu || onMoreButtonClick) && (
                        <button
                            type="button"
                            // data-vtab-menu-trigger lets the open menu's
                            // outside-click handler recognize this click
                            // as "the user wants to toggle me off, not
                            // dismiss elsewhere".  Without it, the menu
                            // closes on mousedown and the kebab's click
                            // re-opens it on the same gesture, so the
                            // menu can never be dismissed by re-clicking
                            // its trigger.
                            data-vtab-menu-trigger="true"
                            className="flex h-[16px] w-[16px] cursor-pointer items-center justify-center rounded-[4px] text-secondary transition-colors hover:bg-fg-overlay-2"
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
                        className="flex h-[16px] w-[16px] cursor-pointer items-center justify-center rounded-[4px] text-secondary transition-colors hover:bg-fg-overlay-3"
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
