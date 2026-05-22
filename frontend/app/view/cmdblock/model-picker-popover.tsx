// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// ModelPickerPopover — sectioned model picker.  V2 (Phase D of the
// ai-config refactor).  Reads from the in-repo catalog + the user's
// ai.json; writes the user's choice back via the parent's
// onSelectionChange.
//
// Layout (mockup in docs/ai-config-architecture.md §9):
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ PROFILES                                                  │
//   │   ★ fast        gpt-5-mini                                │
//   │   ★ deepwork    claude-opus-4-7 · high                    │
//   ├──────────────────────────────────────────────────────────┤
//   │ OPENAI                                                    │
//   │   ◯ gpt-5         (200k · tools · reasoning)              │
//   │   ✓ gpt-5 mini    (200k · tools)            ← selected    │
//   │      ◯ low  ● med  ◯ high                   ← reasoning   │
//   │   ◯ gpt-4o        (128k · tools)                          │
//   │ ...                                                       │
//   ├──────────────────────────────────────────────────────────┤
//   │ ⓘ No providers configured — open ~/.config/crest/ai.json  │
//   ├──────────────────────────────────────────────────────────┤
//   │ 🔍 Search models                                          │
//   │ ↑↓ navigate · ↵ select · esc dismiss                      │
//   └──────────────────────────────────────────────────────────┘

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import {
    FloatingPortal,
    autoUpdate,
    flip,
    offset,
    shift,
    useDismiss,
    useFloating,
    useInteractions,
    useRole,
} from "@floating-ui/react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
    Capability,
    CATALOG,
    ModelEntry,
    ProviderEntry,
    ReasoningLevel,
} from "@/app/store/ai-catalog";
import { AgentSelection } from "@/app/store/ai-types";
import { AIUserConfigStatus } from "@/app/store/ai-user-config";

const POPOVER_WIDTH_PX = 360;
const LIST_MAX_HEIGHT_PX = 360;
const SEARCH_FONT_PX = 12;
const HEADER_FONT_PX = 10;
const ICON_PX = 14;

// =========================================================================
// Public props
// =========================================================================

export interface ModelPickerPopoverProps {
    anchorRef: React.RefObject<HTMLElement>;
    open: boolean;
    onOpenChange: (open: boolean) => void;

    // What's currently selected.  Highlight + ✓ marker driven from
    // this.  Null when nothing is set yet (first run before user picks).
    selection: AgentSelection | null;
    onSelectionChange: (next: AgentSelection) => void;

    // ai.json contents — picker shows profiles + custom_models +
    // custom_endpoints from here, and dims catalog providers the
    // user lacks credentials for.  Null when status != "ok".
    userConfig: AIUserConfig | null;
    userConfigStatus: AIUserConfigStatus;
    userConfigError?: string;

    // Catalog override (testing).  Defaults to in-repo CATALOG.
    catalog?: ProviderEntry[];

    // Optional: how to "fix" empty / malformed ai.json.  Default
    // implementation just shows the file path in the banner; host
    // can wire it to an open-in-editor action.
    onOpenConfigFile?: () => void;
}

// =========================================================================
// Internal row model
// =========================================================================
//
// One row = one pickable thing.  Catalog rows + custom_models rows +
// custom_endpoints model rows all collapse into this shape so the
// search filter / keyboard nav can scan a single flat list, while
// the renderer respects the section breaks.

interface PickRow {
    kind: "profile" | "catalog" | "custom_model" | "custom_endpoint";
    sectionId: string;          // ID used to group adjacent rows visually
    sectionTitle: string;       // SECTION HEADER text (uppercase)
    selection: AgentSelection;  // what gets committed when this row picks
    displayName: string;        // primary label
    subtitle?: string;          // smaller right-side detail (provider · model, or context+caps)
    icon: string;
    // Set true when the user lacks credentials for the underlying
    // provider — row dims and clicking opens the config file rather
    // than committing.
    needsCredentials: boolean;
    // Set when the model supports reasoning AND is the active row;
    // renders an inline level mini-row below.
    reasoningLevels?: ReasoningLevel[];
}

// =========================================================================
// Component
// =========================================================================

export const ModelPickerPopover = memo(
    ({
        anchorRef,
        open,
        onOpenChange,
        selection,
        onSelectionChange,
        userConfig,
        userConfigStatus,
        userConfigError,
        catalog = CATALOG,
        onOpenConfigFile,
    }: ModelPickerPopoverProps) => {
        const [query, setQuery] = useState("");
        const [selectedIdx, setSelectedIdx] = useState(0);
        const searchRef = useRef<HTMLInputElement>(null);
        const listRef = useRef<HTMLDivElement>(null);

        // Build the row list from catalog + user config.  Memoised so
        // typing in the search box doesn't recompute the source data.
        const allRows = useMemo<PickRow[]>(
            () => buildRows(catalog, userConfig),
            [catalog, userConfig]
        );
        const filtered = useMemo(() => filterRows(query, allRows), [query, allRows]);

        // ---------- floating-ui plumbing ----------

        const { refs, floatingStyles, context } = useFloating({
            open,
            onOpenChange,
            placement: "top-end",
            middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
            whileElementsMounted: autoUpdate,
        });
        useLayoutEffect(() => {
            refs.setReference(anchorRef.current);
        });
        const dismiss = useDismiss(context, { outsidePress: true, escapeKey: true });
        const role = useRole(context, { role: "listbox" });
        const { getFloatingProps } = useInteractions([dismiss, role]);

        // ---------- selection / focus management ----------

        useEffect(() => {
            if (!open) {
                setQuery("");
                return;
            }
            const idx = filtered.findIndex((r) => sameSelection(r.selection, selection));
            setSelectedIdx(idx >= 0 ? idx : 0);
            const id = window.setTimeout(() => searchRef.current?.focus(), 0);
            return () => window.clearTimeout(id);
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [open]);

        useEffect(() => {
            if (selectedIdx >= filtered.length) setSelectedIdx(0);
        }, [filtered.length, selectedIdx]);

        useEffect(() => {
            if (!open) return;
            const list = listRef.current;
            if (!list) return;
            const row = list.querySelector<HTMLElement>(`[data-row-idx="${selectedIdx}"]`);
            row?.scrollIntoView({ block: "nearest" });
        }, [selectedIdx, open]);

        // ---------- commit helpers ----------

        const commitRow = useCallback(
            (row: PickRow) => {
                if (row.needsCredentials) {
                    onOpenConfigFile?.();
                    return;
                }
                onSelectionChange(row.selection);
                onOpenChange(false);
            },
            [onSelectionChange, onOpenChange, onOpenConfigFile]
        );

        const commitReasoning = useCallback(
            (row: PickRow, level: ReasoningLevel) => {
                onSelectionChange({ ...row.selection, reasoning: level });
                onOpenChange(false);
            },
            [onSelectionChange, onOpenChange]
        );

        const handleSearchKey = useCallback(
            (e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    if (filtered.length === 0) return;
                    setSelectedIdx((prev) => (prev + 1) % filtered.length);
                    return;
                }
                if (e.key === "ArrowUp") {
                    e.preventDefault();
                    if (filtered.length === 0) return;
                    setSelectedIdx((prev) => (prev - 1 + filtered.length) % filtered.length);
                    return;
                }
                if (e.key === "Enter") {
                    e.preventDefault();
                    const pick = filtered[selectedIdx];
                    if (pick) commitRow(pick);
                    return;
                }
                if (e.key === "Escape") {
                    e.preventDefault();
                    onOpenChange(false);
                    return;
                }
            },
            [filtered, selectedIdx, commitRow, onOpenChange]
        );

        if (!open) return null;

        // Group filtered rows by sectionId so we can render section
        // headers between them.  Preserves the order returned by
        // buildRows (so PROFILES stays at the top, etc.).
        const sections = groupSections(filtered);

        return (
            <FloatingPortal>
                <div
                    ref={refs.setFloating}
                    style={{ ...floatingStyles, width: `${POPOVER_WIDTH_PX}px` }}
                    {...getFloatingProps()}
                    className="z-[1000] overflow-hidden rounded-md border border-fg-overlay-3 bg-fg-overlay-1 shadow-xl backdrop-blur"
                >
                    {/* Empty / error banner (top of list, doesn't scroll away). */}
                    <ConfigBanner
                        status={userConfigStatus}
                        error={userConfigError}
                        rowsCount={allRows.length}
                        onOpenConfigFile={onOpenConfigFile ? () => {
                            // Close the popover before opening the
                            // wizard — the popover's z-index would
                            // otherwise paint over the modal.
                            onOpenChange(false);
                            onOpenConfigFile();
                        } : undefined}
                    />

                    <div
                        ref={listRef}
                        className="flex flex-col overflow-y-auto"
                        style={{ maxHeight: `${LIST_MAX_HEIGHT_PX}px` }}
                    >
                        {filtered.length === 0 && allRows.length > 0 && (
                            <div
                                className="px-3 py-4 text-center font-sans text-secondary/75"
                                style={{ fontSize: `${SEARCH_FONT_PX}px` }}
                            >
                                No models match "{query}"
                            </div>
                        )}
                        {sections.map((section) => (
                            <div key={section.id}>
                                <SectionHeader title={section.title} />
                                {section.rows.map(({ row, idx }) => {
                                    const isSelected = sameSelection(row.selection, selection);
                                    const showReasoningRow =
                                        isSelected && row.reasoningLevels && row.reasoningLevels.length > 0;
                                    return (
                                        <div key={`${row.kind}-${idx}-${row.displayName}`}>
                                            <PickerRow
                                                row={row}
                                                idx={idx}
                                                active={idx === selectedIdx}
                                                selected={isSelected}
                                                onHover={setSelectedIdx}
                                                onPick={() => commitRow(row)}
                                            />
                                            {showReasoningRow && (
                                                <ReasoningSubRow
                                                    levels={row.reasoningLevels!}
                                                    current={selection?.reasoning}
                                                    onPick={(lvl) => commitReasoning(row, lvl)}
                                                />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </div>

                    <SearchFooter
                        inputRef={searchRef}
                        value={query}
                        onChange={setQuery}
                        onKeyDown={handleSearchKey}
                    />
                    <HintFooter />
                </div>
            </FloatingPortal>
        );
    }
);
ModelPickerPopover.displayName = "ModelPickerPopover";

// =========================================================================
// ConfigBanner — top strip showing fatal config errors (missing /
// malformed ai.json).  Hidden when status === "ok".
// =========================================================================

interface ConfigBannerProps {
    status: AIUserConfigStatus;
    error?: string;
    rowsCount: number;
    onOpenConfigFile?: () => void;
}

const ConfigBanner = memo(
    ({ status, error, rowsCount, onOpenConfigFile }: ConfigBannerProps) => {
        if (status === "ok") return null;
        if (status === "loading") {
            return (
                <div
                    className="border-b border-fg-overlay-2 bg-fg-overlay-1/40 px-3 py-2 text-secondary/70"
                    style={{ fontSize: `${SEARCH_FONT_PX}px` }}
                >
                    Loading config…
                </div>
            );
        }
        const isMissing = status === "missing" || (status === "ok" && rowsCount === 0);
        const title = isMissing
            ? "Set up your AI provider"
            : status === "malformed"
                ? "Config file is malformed"
                : "Failed to load AI config";
        const body = isMissing
            ? "Pick a provider, paste your API key, choose a default model — takes 30 seconds."
            : error ?? "Unknown error.";
        const buttonLabel = isMissing ? "Get started" : "Edit ai.json";
        return (
            <div
                className={cn(
                    "border-b px-3 py-2 font-sans",
                    isMissing
                        ? "border-amber-400/40 bg-amber-500/10 text-amber-200"
                        : "border-rose-500/40 bg-rose-500/10 text-rose-300"
                )}
                style={{ fontSize: `${SEARCH_FONT_PX}px` }}
            >
                <div className="font-semibold">{title}</div>
                <div className="mt-0.5 text-foreground/70">{body}</div>
                {onOpenConfigFile && (
                    <button
                        type="button"
                        onClick={onOpenConfigFile}
                        className={cn(
                            "mt-1.5 inline-flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 font-medium",
                            isMissing
                                ? "bg-amber-400 text-black hover:bg-amber-300"
                                : "border border-fg-overlay-3 text-foreground/85 hover:bg-fg-overlay-2/60"
                        )}
                    >
                        {buttonLabel}
                    </button>
                )}
            </div>
        );
    }
);
ConfigBanner.displayName = "ConfigBanner";

// =========================================================================
// SectionHeader — small uppercase label between groups
// =========================================================================

const SectionHeader = memo(({ title }: { title: string }) => (
    <div
        className="border-b border-fg-overlay-2/40 bg-fg-overlay-1/30 px-3 py-1 font-sans uppercase tracking-wider text-secondary/65"
        style={{ fontSize: `${HEADER_FONT_PX}px` }}
    >
        {title}
    </div>
));
SectionHeader.displayName = "SectionHeader";

// =========================================================================
// PickerRow — single model entry
// =========================================================================

interface PickerRowProps {
    row: PickRow;
    idx: number;
    active: boolean;
    selected: boolean;
    onHover: (idx: number) => void;
    onPick: () => void;
}

const PickerRow = memo(({ row, idx, active, selected, onHover, onPick }: PickerRowProps) => {
    return (
        <button
            type="button"
            data-row-idx={idx}
            onMouseEnter={() => onHover(idx)}
            onMouseDown={(e) => {
                e.preventDefault();
                onPick();
            }}
            className={cn(
                "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left transition-colors",
                active ? "bg-fg-overlay-2/70" : "hover:bg-fg-overlay-1",
                row.needsCredentials && "opacity-55"
            )}
        >
            <UIcon
                name={row.icon}
                size={ICON_PX}
                className={cn("shrink-0", active ? "text-foreground/95" : "text-secondary/80")}
            />
            <span className="flex min-w-0 flex-1 flex-col">
                <span
                    className="truncate font-sans text-foreground/95"
                    style={{ fontSize: `${SEARCH_FONT_PX}px`, lineHeight: 1.2 }}
                >
                    {row.displayName}
                </span>
                {row.subtitle && (
                    <span
                        className="truncate font-sans text-secondary/65"
                        style={{ fontSize: `${HEADER_FONT_PX + 1}px`, lineHeight: 1.2 }}
                    >
                        {row.subtitle}
                    </span>
                )}
            </span>
            {row.needsCredentials && (
                <span
                    className="shrink-0 rounded border border-amber-400/40 bg-amber-500/10 px-1 py-0 font-sans uppercase tracking-wider text-amber-300"
                    style={{ fontSize: "9px" }}
                >
                    Add key
                </span>
            )}
            {selected ? (
                <UIcon name="check" size={ICON_PX} className="shrink-0 text-[var(--ansi-green)]" />
            ) : (
                <span className="inline-block shrink-0" style={{ width: `${ICON_PX}px` }} />
            )}
        </button>
    );
});
PickerRow.displayName = "PickerRow";

// =========================================================================
// ReasoningSubRow — inline level picker under a selected reasoning-capable
// row.  Replaces warp's hover-sidecar UX with a simpler always-visible
// chip group (only when the row is the active selection).
// =========================================================================

interface ReasoningSubRowProps {
    levels: ReasoningLevel[];
    current?: ReasoningLevel;
    onPick: (level: ReasoningLevel) => void;
}

const ReasoningSubRow = memo(({ levels, current, onPick }: ReasoningSubRowProps) => (
    <div className="flex items-center gap-1 border-b border-fg-overlay-2/30 bg-fg-overlay-1/20 px-3 py-1 pl-9">
        <span
            className="mr-1 font-sans uppercase tracking-wider text-secondary/60"
            style={{ fontSize: `${HEADER_FONT_PX}px` }}
        >
            reasoning
        </span>
        {levels.map((lvl) => (
            <button
                key={lvl}
                type="button"
                onMouseDown={(e) => {
                    e.preventDefault();
                    onPick(lvl);
                }}
                className={cn(
                    "cursor-pointer rounded border px-1.5 py-0.5 font-sans transition-colors",
                    current === lvl
                        ? "border-[var(--ansi-yellow)]/60 bg-[var(--ansi-yellow)]/15 text-[var(--ansi-yellow)]"
                        : "border-fg-overlay-2/50 bg-transparent text-foreground/80 hover:bg-fg-overlay-2/60"
                )}
                style={{ fontSize: `${HEADER_FONT_PX + 1}px` }}
            >
                {lvl}
            </button>
        ))}
    </div>
));
ReasoningSubRow.displayName = "ReasoningSubRow";

// =========================================================================
// SearchFooter — sticky bottom input
// =========================================================================

interface SearchFooterProps {
    inputRef: React.RefObject<HTMLInputElement>;
    value: string;
    onChange: (v: string) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

const SearchFooter = memo(({ inputRef, value, onChange, onKeyDown }: SearchFooterProps) => (
    <div className="flex items-center gap-2 border-t border-fg-overlay-2 px-3 py-2">
        <UIcon name="search" size={ICON_PX - 1} className="shrink-0 text-secondary/60" />
        <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search models"
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-transparent font-sans text-foreground outline-none placeholder:text-secondary/55"
            style={{ fontSize: `${SEARCH_FONT_PX}px` }}
        />
    </div>
));
SearchFooter.displayName = "SearchFooter";

const HintFooter = memo(() => (
    <div
        className="flex items-center gap-x-4 border-t border-fg-overlay-2 bg-fg-overlay-1/60 px-3 py-1.5 font-sans text-secondary/65"
        style={{ fontSize: `${HEADER_FONT_PX + 1}px` }}
    >
        <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">↑</kbd>
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">↓</kbd>
            <span>navigate</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">↵</kbd>
            <span>select</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1.5">esc</kbd>
            <span>dismiss</span>
        </span>
    </div>
));
HintFooter.displayName = "HintFooter";

// =========================================================================
// Row construction
// =========================================================================
//
// buildRows produces a flat ordered list of PickRow.  Sections are
// rendered later by grouping adjacent rows that share sectionId — so
// the order of rows here is also the visual order in the popover.

function buildRows(
    catalog: ProviderEntry[],
    userConfig: AIUserConfig | null
): PickRow[] {
    const rows: PickRow[] = [];

    // Profiles first.  Each profile becomes a row; subtitle shows the
    // resolved provider/model so the user knows what they're picking.
    if (userConfig?.profiles) {
        for (const [name, sel] of Object.entries(userConfig.profiles)) {
            rows.push({
                kind: "profile",
                sectionId: "profiles",
                sectionTitle: "Profiles",
                selection: {
                    provider: sel.provider,
                    model: sel.model,
                    reasoning: sel.reasoning as ReasoningLevel | undefined,
                },
                displayName: name,
                subtitle: profileSubtitle(sel),
                icon: "star",
                needsCredentials: false,
            });
        }
    }

    // Catalog providers in their declared order.  Each provider is its
    // own section; dimmed when the user has no credentials configured.
    for (const provider of catalog) {
        const hasCreds = !!userConfig?.providers?.[provider.id];
        for (const model of provider.models) {
            rows.push({
                kind: "catalog",
                sectionId: `provider-${provider.id}`,
                sectionTitle: provider.displayName,
                selection: { provider: provider.id, model: model.id },
                displayName: model.displayName,
                subtitle: modelSubtitle(model),
                icon: provider.icon,
                needsCredentials: !hasCreds,
                reasoningLevels: model.reasoningLevels,
            });
        }
    }

    // User custom models — group under their owning provider section
    // when that provider id matches a catalog entry; otherwise their
    // own catch-all section.
    if (userConfig?.custom_models) {
        for (const cm of userConfig.custom_models) {
            const provider = catalog.find((p) => p.id === cm.provider);
            const sectionTitle = provider?.displayName ?? "Custom models";
            const sectionId = provider ? `provider-${provider.id}-custom` : "custom-models";
            const hasCreds = !!userConfig.providers?.[cm.provider];
            rows.push({
                kind: "custom_model",
                sectionId,
                sectionTitle,
                selection: { provider: cm.provider, model: cm.id },
                displayName: cm.displayname,
                subtitle: customModelSubtitle(cm),
                icon: provider?.icon ?? "code-02",
                needsCredentials: !hasCreds,
                reasoningLevels: cm.reasoninglevels as ReasoningLevel[] | undefined,
            });
        }
    }

    // Custom endpoints — each endpoint is its own section.
    if (userConfig?.custom_endpoints) {
        for (const [epId, ep] of Object.entries(userConfig.custom_endpoints)) {
            const hasCreds = !!userConfig.providers?.[epId];
            for (const model of ep.models) {
                rows.push({
                    kind: "custom_endpoint",
                    sectionId: `endpoint-${epId}`,
                    sectionTitle: ep.displayname,
                    selection: { provider: epId, model: model.id },
                    displayName: model.displayName,
                    subtitle: endpointModelSubtitle(model, ep.endpoint),
                    icon: ep.icon || "server",
                    needsCredentials: !hasCreds,
                    reasoningLevels: model.reasoningLevels as ReasoningLevel[] | undefined,
                });
            }
        }
    }

    return rows;
}

function profileSubtitle(sel: { provider: string; model: string; reasoning?: string }): string {
    const base = `${sel.provider} · ${sel.model}`;
    return sel.reasoning ? `${base} · ${sel.reasoning}` : base;
}

function modelSubtitle(model: ModelEntry): string {
    const parts: string[] = [];
    parts.push(formatContext(model.contextWindow));
    parts.push(model.capabilities.map(formatCapability).filter(Boolean).join(" · "));
    return parts.filter(Boolean).join(" · ");
}

function customModelSubtitle(cm: {
    capabilities: Capability[];
    contextwindow: number;
}): string {
    const parts: string[] = [];
    parts.push(formatContext(cm.contextwindow));
    parts.push(cm.capabilities.map(formatCapability).filter(Boolean).join(" · "));
    return parts.filter(Boolean).join(" · ");
}

function endpointModelSubtitle(
    model: { capabilities: Capability[]; contextWindow: number },
    endpoint: string
): string {
    const host = (() => {
        try {
            return new URL(endpoint).host;
        } catch {
            return "";
        }
    })();
    const parts = [host, formatContext(model.contextWindow), model.capabilities.map(formatCapability).filter(Boolean).join(" · ")];
    return parts.filter(Boolean).join(" · ");
}

function formatContext(tokens: number): string {
    if (!tokens) return "";
    if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M ctx`;
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`;
    return `${tokens} ctx`;
}

function formatCapability(cap: Capability): string {
    return cap;
}

// =========================================================================
// Filter + grouping
// =========================================================================

function filterRows(query: string, rows: PickRow[]): PickRow[] {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
        const hay = [
            r.displayName,
            r.subtitle,
            r.selection.provider,
            r.selection.model,
            r.sectionTitle,
        ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
        return hay.includes(q);
    });
}

interface GroupedSection {
    id: string;
    title: string;
    rows: Array<{ row: PickRow; idx: number }>;
}

function groupSections(rows: PickRow[]): GroupedSection[] {
    const out: GroupedSection[] = [];
    rows.forEach((row, idx) => {
        const last = out[out.length - 1];
        if (last && last.id === row.sectionId) {
            last.rows.push({ row, idx });
        } else {
            out.push({ id: row.sectionId, title: row.sectionTitle, rows: [{ row, idx }] });
        }
    });
    return out;
}

function sameSelection(a: AgentSelection, b: AgentSelection | null): boolean {
    if (!b) return false;
    return (
        a.provider === b.provider &&
        a.model === b.model &&
        (a.reasoning ?? null) === (b.reasoning ?? null)
    );
}
