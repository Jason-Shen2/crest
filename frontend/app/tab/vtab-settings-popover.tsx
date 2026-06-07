// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UIcon } from "@/app/element/ui-icon";
import { getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { Tooltip } from "@/app/element/tooltip";
import { cn, fireAndForget } from "@/util/util";
import { FloatingPortal } from "@floating-ui/react";
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";

// Public — kept aligned with VerticalTabs* settings on TabSettings in
// warp's `app/src/workspace/tab_settings.rs`.  Default values mirror
// warp's `default()` impls.
export type VtabGranularity = "tabs" | "panes";
export type VtabViewMode = "compact" | "expanded";
export type VtabPrimaryInfo = "command" | "workingdir" | "branch";
export type VtabCompactSubtitle = "none" | "command" | "workingdir" | "branch";

export const DefaultGranularity: VtabGranularity = "tabs";
export const DefaultViewMode: VtabViewMode = "expanded";
export const DefaultPrimaryInfo: VtabPrimaryInfo = "command";
export const DefaultShowDiffStats = true;
export const DefaultShowDetailsOnHover = false;
export const DefaultShowPrLink = false;

export function resolveCompactSubtitle(
    primary: VtabPrimaryInfo,
    subtitle: VtabCompactSubtitle
): VtabCompactSubtitle {
    // warp's `resolve_compact_subtitle`: subtitle can't equal primary; if
    // the user picked the same field for both, drop subtitle to "none".
    if (
        (primary === "command" && subtitle === "command") ||
        (primary === "workingdir" && subtitle === "workingdir") ||
        (primary === "branch" && subtitle === "branch")
    ) {
        return "none";
    }
    return subtitle;
}

export function subtitleOptionsForPrimary(
    primary: VtabPrimaryInfo
): { value: VtabCompactSubtitle; label: string }[] {
    // warp's `subtitle_options_for_primary` — the user picks one of two
    // remaining fields plus "None".
    switch (primary) {
        case "command":
            return [
                { value: "none", label: "None" },
                { value: "workingdir", label: "Working Directory" },
                { value: "branch", label: "Branch" },
            ];
        case "workingdir":
            return [
                { value: "none", label: "None" },
                { value: "command", label: "Command / Conversation" },
                { value: "branch", label: "Branch" },
            ];
        case "branch":
            return [
                { value: "none", label: "None" },
                { value: "command", label: "Command / Conversation" },
                { value: "workingdir", label: "Working Directory" },
            ];
    }
}

function setConfig<T>(key: string, value: T): void {
    fireAndForget(() => RpcApi.SetConfigCommand(TabRpcClient, { [key]: value as unknown as never }));
}

interface SegmentProps {
    selected: boolean;
    onClick: () => void;
    children: React.ReactNode;
    ariaLabel: string;
}

function Segment({ selected, onClick, children, ariaLabel }: SegmentProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={ariaLabel}
            aria-pressed={selected}
            className={cn(
                "flex flex-1 cursor-pointer items-center justify-center rounded py-1 transition-colors",
                selected ? "bg-fg-overlay-3 text-foreground" : "text-secondary hover:bg-fg-overlay-1"
            )}
        >
            {children}
        </button>
    );
}

interface RadioRowProps {
    selected: boolean;
    label: string;
    onClick: () => void;
    rightSlot?: React.ReactNode;
}

function RadioRow({ selected, label, onClick, rightSlot }: RadioRowProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex w-full cursor-pointer items-center gap-2 px-4 py-[3px] text-left text-[15px] text-foreground hover:bg-fg-overlay-1"
        >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {selected && <UIcon name="check" size={14} />}
            </span>
            <span className="flex-1 truncate">{label}</span>
            {rightSlot}
        </button>
    );
}

interface ToggleRowProps {
    enabled: boolean;
    label: string;
    onClick: () => void;
    infoTooltip?: string;
}

function ToggleRow({ enabled, label, onClick, infoTooltip }: ToggleRowProps) {
    // Warp `render_show_toggle_option` (vertical_tabs.rs 5118-5210):
    // checkbox style row with an optional info icon on the right.
    return (
        <button
            type="button"
            onClick={onClick}
            className="flex w-full cursor-pointer items-center gap-2 px-4 py-[3px] text-left text-[15px] text-foreground hover:bg-fg-overlay-1"
        >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {enabled && <UIcon name="check" size={14} />}
            </span>
            <span className="flex-1 truncate">{label}</span>
            {infoTooltip && enabled && (
                <Tooltip content={infoTooltip} placement="top" divClassName="shrink-0">
                    <UIcon name="alert-circle" size={12} className="text-secondary" />
                </Tooltip>
            )}
        </button>
    );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
    return <div className="mb-1 px-4 pt-2 text-[15px] text-secondary">{children}</div>;
}

function Divider() {
    return <div className="my-2 h-px bg-fg-overlay-2" />;
}

interface VtabSettingsPopoverProps {
    onClose: () => void;
    anchorRect: DOMRect;
}

export function VtabSettingsPopover({ onClose, anchorRect }: VtabSettingsPopoverProps) {
    const granularity =
        (useAtomValue(getSettingsKeyAtom("vtab:granularity")) as VtabGranularity) || DefaultGranularity;
    const viewMode = (useAtomValue(getSettingsKeyAtom("vtab:viewmode")) as VtabViewMode) || DefaultViewMode;
    const primaryInfo =
        (useAtomValue(getSettingsKeyAtom("vtab:primaryinfo")) as VtabPrimaryInfo) || DefaultPrimaryInfo;
    const compactSubtitleRaw =
        (useAtomValue(getSettingsKeyAtom("vtab:compactsubtitle")) as VtabCompactSubtitle) || "workingdir";
    const compactSubtitle = resolveCompactSubtitle(primaryInfo, compactSubtitleRaw);
    const showDiffStatsRaw = useAtomValue(getSettingsKeyAtom("vtab:showdiffstats"));
    const showDetailsRaw = useAtomValue(getSettingsKeyAtom("vtab:showdetailsonhover"));
    const showPrLinkRaw = useAtomValue(getSettingsKeyAtom("vtab:showprlink"));
    const showDiffStats = showDiffStatsRaw ?? DefaultShowDiffStats;
    const showDetails = showDetailsRaw ?? DefaultShowDetailsOnHover;
    const showPrLink = showPrLinkRaw ?? DefaultShowPrLink;

    const popoverRef = useRef<HTMLDivElement>(null);

    // Dismiss on outside click / Escape.  Match the native context menu
    // semantics already used by the rest of the panel.
    useEffect(() => {
        const onMouseDown = (e: MouseEvent) => {
            if (popoverRef.current && e.target instanceof Node && popoverRef.current.contains(e.target)) {
                return;
            }
            onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("mousedown", onMouseDown, true);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("mousedown", onMouseDown, true);
            window.removeEventListener("keydown", onKey);
        };
    }, [onClose]);

    // Anchor 6px below the settings button, left-aligned but kept within
    // the viewport.  warp uses an `OffsetPositioning` overlay that does
    // the same thing in `render_settings_popup`'s caller.
    const popoverWidth = 220;
    const left = Math.min(anchorRect.left, window.innerWidth - popoverWidth - 8);
    const top = anchorRect.bottom + 6;

    // FloatingPortal renders to document.body, escaping the VTabBar
    // parent's backdrop-filter stacking context which would otherwise
    // trap `z-50` underneath the file panel.
    return (
        <FloatingPortal>
        <div
            ref={popoverRef}
            role="dialog"
            aria-label="Tab panel view options"
            className="fixed z-50 overflow-hidden rounded-md border border-fg-overlay-1 bg-background py-2 shadow-[0_4px_24px_rgba(0,0,0,0.45)]"
            style={{ top, left, width: popoverWidth }}
            onClick={(e) => e.stopPropagation()}
        >
            {/* View as — Panes vs Tabs.  Warp's render_settings_popup
                renders this first; matches the source order so the
                popover reads top-down identically. */}
            <SectionHeader>View as</SectionHeader>
            <div className="mx-4 mb-1 flex gap-[2px] rounded-md bg-fg-overlay-2 p-1">
                <Segment
                    selected={granularity === "panes"}
                    onClick={() => setConfig("vtab:granularity", "panes")}
                    ariaLabel="Panes"
                >
                    <span className="text-[15px]">Panes</span>
                </Segment>
                <Segment
                    selected={granularity === "tabs"}
                    onClick={() => setConfig("vtab:granularity", "tabs")}
                    ariaLabel="Tabs"
                >
                    <span className="text-[15px]">Tabs</span>
                </Segment>
            </div>

            <Divider />

            {/* Density — Compact vs Expanded segmented control. */}
            <SectionHeader>Density</SectionHeader>
            <div className="mx-4 mb-1 flex gap-[2px] rounded-md bg-fg-overlay-2 p-1">
                <Segment
                    selected={viewMode === "compact"}
                    onClick={() => setConfig("vtab:viewmode", "compact")}
                    ariaLabel="Compact"
                >
                    <UIcon name="menu-01" size={14} />
                </Segment>
                <Segment
                    selected={viewMode === "expanded"}
                    onClick={() => setConfig("vtab:viewmode", "expanded")}
                    ariaLabel="Expanded"
                >
                    <UIcon name="grid" size={14} />
                </Segment>
            </div>

            <Divider />

            {/* Pane title as — single-pick. */}
            <SectionHeader>Pane title as</SectionHeader>
            <RadioRow
                selected={primaryInfo === "command"}
                label="Command / Conversation"
                onClick={() => setConfig("vtab:primaryinfo", "command")}
            />
            <RadioRow
                selected={primaryInfo === "workingdir"}
                label="Working Directory"
                onClick={() => setConfig("vtab:primaryinfo", "workingdir")}
            />
            <RadioRow
                selected={primaryInfo === "branch"}
                label="Branch"
                onClick={() => setConfig("vtab:primaryinfo", "branch")}
            />

            {viewMode === "compact" && (
                <>
                    <Divider />
                    <SectionHeader>Additional metadata</SectionHeader>
                    {subtitleOptionsForPrimary(primaryInfo).map((opt) => (
                        <RadioRow
                            key={opt.value}
                            selected={compactSubtitle === opt.value}
                            label={opt.label}
                            onClick={() => setConfig("vtab:compactsubtitle", opt.value)}
                        />
                    ))}
                </>
            )}

            {viewMode === "expanded" && (
                <>
                    <Divider />
                    <SectionHeader>Show</SectionHeader>
                    <ToggleRow
                        enabled={showPrLink}
                        label="PR link"
                        onClick={() => setConfig("vtab:showprlink", !showPrLink)}
                    />
                    <ToggleRow
                        enabled={showDiffStats}
                        label="Diff stats"
                        onClick={() => setConfig("vtab:showdiffstats", !showDiffStats)}
                    />
                </>
            )}

            <Divider />

            <ToggleRow
                enabled={showDetails}
                label="Show details on hover"
                onClick={() => setConfig("vtab:showdetailsonhover", !showDetails)}
            />
        </div>
        </FloatingPortal>
    );
}

// Helper for read-only callers that just want the resolved value (e.g.
// VTab row rendering) without subscribing to atoms.
export function getResolvedVtabSettings() {
    const granularity =
        (globalStore.get(getSettingsKeyAtom("vtab:granularity")) as VtabGranularity) ||
        DefaultGranularity;
    const viewMode =
        (globalStore.get(getSettingsKeyAtom("vtab:viewmode")) as VtabViewMode) || DefaultViewMode;
    const primaryInfo =
        (globalStore.get(getSettingsKeyAtom("vtab:primaryinfo")) as VtabPrimaryInfo) ||
        DefaultPrimaryInfo;
    const compactSubtitle = resolveCompactSubtitle(
        primaryInfo,
        (globalStore.get(getSettingsKeyAtom("vtab:compactsubtitle")) as VtabCompactSubtitle) ||
            "workingdir"
    );
    const showDiffStats =
        globalStore.get(getSettingsKeyAtom("vtab:showdiffstats")) ?? DefaultShowDiffStats;
    const showDetailsOnHover =
        globalStore.get(getSettingsKeyAtom("vtab:showdetailsonhover")) ?? DefaultShowDetailsOnHover;
    const showPrLink = globalStore.get(getSettingsKeyAtom("vtab:showprlink")) ?? DefaultShowPrLink;
    return {
        granularity,
        viewMode,
        primaryInfo,
        compactSubtitle,
        showDiffStats,
        showDetailsOnHover,
        showPrLink,
    };
}
