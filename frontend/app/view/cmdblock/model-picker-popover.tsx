// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// ModelPickerPopover — tab-based model picker (V3).
//
// Layout:
//
//   ┌──────────────────────────────────────────────────────────┐
//   │ [Config banner — only when status≠ok]                     │
//   │ PROFILES (only when userConfig.profiles is non-empty)     │
//   │   ★ fast        gpt-5-mini                                │
//   ├──────────────────────────────────────────────────────────┤
//   │ ☆ Pinned   OpenAI   Anthropic   OpenRouter      ＋ Add  ⟳ │
//   ├──────────────────────────────────────────────────────────┤
//   │   ◯ gpt-5         200k · tools · reasoning      ☆        │
//   │   ✓ gpt-5 mini    200k · tools                  ★        │
//   │      ◯ low  ● med  ◯ high                                │
//   │   ...                                                     │
//   ├──────────────────────────────────────────────────────────┤
//   │ 🔍 Search models                                          │
//   │ ↑↓ navigate · ⇥ switch tab · ↵ select · esc dismiss      │
//   └──────────────────────────────────────────────────────────┘
//
// Key differences from V2:
//   - Only providers with saved credentials appear as tabs. An "+ Add"
//     tab opens the AI setup wizard for unconfigured providers.
//   - The active provider tab fetches catalog facts from Electron and
//     account/deployment availability from the provider's /models API.
//   - A cross-provider Pinned tab surfaces user-starred models for
//     quick access. Pins persist via ai.json (Pinned []PinnedModel).

import { Tooltip } from "@/app/element/tooltip";
import { UIcon } from "@/app/element/ui-icon";
import { globalStore } from "@/app/store/jotaiStore";
import { atoms } from "@/store/global";
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
import { useAtomValue } from "jotai";
import { Pin } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
    CATALOG,
    Capability,
    ModelEntry,
    ProviderEntry,
    ReasoningLevel,
    projectRegistryCatalog,
} from "@/app/store/ai-catalog";
import {
    ProviderModelInfoLite,
    fetchProviderModels,
    providerDisplayName,
    providerIcon,
    providerModelsAtomFor,
    providersWithCredentials,
    refreshProviderModels,
} from "@/app/store/ai-provider-models";
import { fetchRegistryModels, refreshRegistryModels, registryModelsMapAtom } from "@/app/store/ai-registry-models";
import { AIUserConfig, AgentSelection, UserCustomEndpointModel, UserCustomModel } from "@/app/store/ai-types";
import { AIUserConfigStatus, isPinned, togglePinned } from "@/app/store/ai-user-config";
import { CommandInlineFrame } from "./command-inline-frame";

const POPOVER_WIDTH_PX = 340;
const LIST_MAX_HEIGHT_PX = 360;
const SEARCH_FONT_PX = 12;
const HEADER_FONT_PX = 10;
const ICON_PX = 14;

// =========================================================================
// Public props (unchanged)
// =========================================================================

export interface ModelPickerPopoverProps {
    anchorRef: React.RefObject<HTMLElement>;
    open: boolean;
    onOpenChange: (open: boolean) => void;

    selection: AgentSelection | null;
    onSelectionChange: (next: AgentSelection) => void;

    userConfig: AIUserConfig | null;
    userConfigStatus: AIUserConfigStatus;
    userConfigError?: string;

    catalog?: ProviderEntry[];

    onOpenConfigFile?: () => void;
}

// =========================================================================
// Tab + row models
// =========================================================================

type TabKind = "pinned" | "provider" | "add";

interface TabSpec {
    id: string; // "pinned" | providerId | "__add"
    kind: TabKind;
    label: string;
    icon: React.ReactNode;
    providerId?: string;
}

interface ModelDetail {
    modelId: string;
    providerLabel: string;
    description?: string;
    contextWindow?: number;
    capabilities?: Capability[];
    reasoningLevels?: ReasoningLevel[];
    // Live-fetch extras (currently populated only for OpenRouter). FE
    // displays them when present; absent values hide the row instead of
    // showing zeros.
    maxOutputTokens?: number;
    promptCostPerToken?: number;
    completionCostPerToken?: number;
    imageCostPerImage?: number;
    inputModalities?: string[];
    tokenizer?: string;
    isModerated?: boolean;
}

interface PickRow {
    key: string;
    selection: AgentSelection;
    displayName: string;
    subtitle?: string;
    icon: string;
    providerId: string;
    needsCredentials: boolean;
    reasoningLevels?: ReasoningLevel[];
    pinnable: boolean;
    detail: ModelDetail;
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
        const [activeTab, setActiveTab] = useState<string>("");
        const searchRef = useRef<HTMLInputElement>(null);
        const listRef = useRef<HTMLDivElement>(null);
        const registryModelsMap = useAtomValue(registryModelsMapAtom);
        const effectiveCatalog = useMemo(
            () => projectRegistryCatalog(catalog, registryModelsMap),
            [catalog, registryModelsMap]
        );

        const configuredProviders = useMemo(() => providersWithCredentials(userConfig), [userConfig]);

        const tabs = useMemo<TabSpec[]>(
            () => buildTabs(configuredProviders, userConfig),
            [configuredProviders, userConfig]
        );

        // Pick a sensible default tab on open: the provider of the current
        // selection if it's configured, else the first configured provider,
        // else the Pinned tab (which may itself be empty — fine; it renders
        // a hint).
        useEffect(() => {
            if (!open) return;
            const want =
                (selection && configuredProviders.includes(selection.provider) ? selection.provider : null) ??
                configuredProviders[0] ??
                "pinned";
            setActiveTab((cur) => (tabs.some((t) => t.id === cur) ? cur : want));
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [open]);

        // Catalog facts and account/deployment availability are
        // independent reads with separate failure and cache state.
        useEffect(() => {
            if (!open) return;
            const tab = tabs.find((t) => t.id === activeTab);
            if (tab?.kind === "provider" && tab.providerId) {
                void Promise.all([
                    fetchRegistryModels(tab.providerId),
                    fetchProviderModels(tab.providerId, userConfig),
                ]);
            }
        }, [open, activeTab, tabs, userConfig]);

        // ---------- live state for the active provider tab ----------

        const activeTabSpec = tabs.find((t) => t.id === activeTab);
        const liveAtom = useMemo(
            () => providerModelsAtomFor(activeTabSpec?.providerId ?? ""),
            [activeTabSpec?.providerId]
        );
        const liveState = useAtomValue(liveAtom);

        // ---------- row list for the active tab ----------

        const rows = useMemo<PickRow[]>(() => {
            if (!activeTabSpec) return [];
            if (activeTabSpec.kind === "pinned") return buildPinnedRows(effectiveCatalog, userConfig);
            if (activeTabSpec.kind === "provider" && activeTabSpec.providerId) {
                return buildProviderRows(
                    activeTabSpec.providerId,
                    effectiveCatalog,
                    userConfig,
                    liveState.status === "ok" ? liveState.models : null
                );
            }
            return [];
        }, [activeTabSpec, effectiveCatalog, userConfig, liveState]);

        const filtered = useMemo(() => filterRows(query, rows), [query, rows]);

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
            const id = window.setTimeout(() => searchRef.current?.focus(), 0);
            return () => window.clearTimeout(id);
        }, [open]);

        // Reset cursor to the selected row whenever the active tab or
        // filtered list shifts. Falls back to row 0 when nothing matches.
        useEffect(() => {
            const idx = filtered.findIndex((r) => sameSelection(r.selection, selection));
            setSelectedIdx(idx >= 0 ? idx : 0);
        }, [filtered, selection]);

        useEffect(() => {
            if (!open) return;
            const list = listRef.current;
            if (!list) return;
            const row = list.querySelector<HTMLElement>(`[data-row-idx="${selectedIdx}"]`);
            row?.scrollIntoView({ block: "nearest" });
        }, [selectedIdx, open]);

        // ---------- handlers ----------

        const handleTabClick = useCallback(
            (tab: TabSpec) => {
                if (tab.kind === "add") {
                    onOpenChange(false);
                    onOpenConfigFile?.();
                    return;
                }
                setActiveTab(tab.id);
                setQuery("");
            },
            [onOpenChange, onOpenConfigFile]
        );

        const commitRow = useCallback(
            (row: PickRow) => {
                if (row.needsCredentials) {
                    onOpenChange(false);
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

        const handlePinToggle = useCallback(async (row: PickRow) => {
            try {
                await togglePinned(row.selection.provider, row.selection.model);
            } catch (e) {
                // Surface in the console — the picker is too thin for a
                // toast surface, and a failed pin doesn't block the
                // user from selecting the model.
                // eslint-disable-next-line no-console
                console.error("toggle pin failed:", e);
            }
        }, []);

        const handleRefresh = useCallback(() => {
            if (activeTabSpec?.kind === "provider" && activeTabSpec.providerId) {
                void Promise.all([
                    refreshRegistryModels(activeTabSpec.providerId),
                    refreshProviderModels(activeTabSpec.providerId, userConfig),
                ]);
            }
        }, [activeTabSpec, userConfig]);

        const cycleTab = useCallback(
            (dir: 1 | -1) => {
                const switchable = tabs.filter((t) => t.kind !== "add");
                if (switchable.length === 0) return;
                const curIdx = switchable.findIndex((t) => t.id === activeTab);
                const nextIdx = (curIdx + dir + switchable.length) % switchable.length;
                setActiveTab(switchable[nextIdx].id);
                setQuery("");
            },
            [tabs, activeTab]
        );

        const handleSearchKey = useCallback(
            (e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Tab") {
                    e.preventDefault();
                    cycleTab(e.shiftKey ? -1 : 1);
                    return;
                }
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
            [filtered, selectedIdx, commitRow, onOpenChange, cycleTab]
        );

        if (!open) return null;

        const showRefresh = activeTabSpec?.kind === "provider";
        const registryState = registryModelsMap[activeTabSpec?.providerId ?? ""];
        const isLoading = showRefresh && (liveState.status === "loading" || registryState?.status === "loading");

        return (
            <FloatingPortal>
                <div
                    ref={refs.setFloating}
                    style={{ ...floatingStyles, width: `${POPOVER_WIDTH_PX}px` }}
                    {...getFloatingProps()}
                    // Block React-bubbled click/mousedown from reaching the
                    // enclosing block in block.tsx. That handler treats any
                    // click as "user clicked into this block" and calls
                    // setFocusTarget(), which moves focus back to the
                    // editor — and steals it from the picker's search input
                    // immediately after the click lands here. The popover
                    // is portal'd, so DOM ancestors don't see these events;
                    // we only need to break the React-tree bubbling chain.
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="z-[1000] overflow-hidden rounded-md border border-fg-overlay-3 bg-fg-overlay-1 shadow-xl backdrop-blur"
                >
                    <ConfigBanner
                        status={userConfigStatus}
                        error={userConfigError}
                        configuredCount={configuredProviders.length}
                        onOpenConfigFile={
                            onOpenConfigFile
                                ? () => {
                                      onOpenChange(false);
                                      onOpenConfigFile();
                                  }
                                : undefined
                        }
                    />

                    <ProfilesStrip
                        userConfig={userConfig}
                        selection={selection}
                        onPick={(sel) => {
                            onSelectionChange(sel);
                            onOpenChange(false);
                        }}
                    />

                    <TabBar
                        tabs={tabs}
                        activeTab={activeTab}
                        onTabClick={handleTabClick}
                        showRefresh={showRefresh}
                        refreshing={isLoading}
                        onRefresh={handleRefresh}
                    />

                    <SearchBar
                        inputRef={searchRef}
                        value={query}
                        onChange={setQuery}
                        onKeyDown={handleSearchKey}
                        placeholder={searchPlaceholder(activeTabSpec)}
                    />

                    <div
                        ref={listRef}
                        className="flex flex-col overflow-y-auto"
                        style={{ maxHeight: `${LIST_MAX_HEIGHT_PX}px` }}
                    >
                        <TabContent
                            tab={activeTabSpec}
                            rows={filtered}
                            allRowsCount={rows.length}
                            query={query}
                            liveState={liveState}
                            userConfig={userConfig}
                            selection={selection}
                            selectedIdx={selectedIdx}
                            onHover={setSelectedIdx}
                            onPick={commitRow}
                            onPickReasoning={commitReasoning}
                            onPinToggle={handlePinToggle}
                        />
                    </div>

                    <HintFooter showTabHint={tabs.filter((t) => t.kind !== "add").length > 1} />
                </div>
            </FloatingPortal>
        );
    }
);
ModelPickerPopover.displayName = "ModelPickerPopover";

// =========================================================================
// ConfigBanner
// =========================================================================

interface ConfigBannerProps {
    status: AIUserConfigStatus;
    error?: string;
    configuredCount: number;
    onOpenConfigFile?: () => void;
}

const ConfigBanner = memo(({ status, error, configuredCount, onOpenConfigFile }: ConfigBannerProps) => {
    if (status === "ok" && configuredCount > 0) return null;
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
    const isMissing = status === "missing" || (status === "ok" && configuredCount === 0);
    const title = isMissing
        ? "Set up your AI provider"
        : status === "malformed"
          ? "Config file is malformed"
          : "Failed to load AI config";
    const body = isMissing ? "Pick a provider and paste your API key — takes 30 seconds." : (error ?? "Unknown error.");
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
});
ConfigBanner.displayName = "ConfigBanner";

// =========================================================================
// ProfilesStrip — small section above the tab bar listing profile shortcuts
// =========================================================================

interface ProfilesStripProps {
    userConfig: AIUserConfig | null;
    selection: AgentSelection | null;
    onPick: (sel: AgentSelection) => void;
}

const ProfilesStrip = memo(({ userConfig, selection, onPick }: ProfilesStripProps) => {
    const entries = userConfig?.profiles ? Object.entries(userConfig.profiles) : [];
    if (entries.length === 0) return null;
    return (
        <div className="border-b border-fg-overlay-2/60 px-2 py-1.5">
            <div
                className="mb-1 px-1 font-sans uppercase tracking-wider text-secondary/65"
                style={{ fontSize: `${HEADER_FONT_PX}px` }}
            >
                Profiles
            </div>
            <div className="flex flex-wrap gap-1">
                {entries.map(([name, sel]) => {
                    const isActive = sameSelection(
                        {
                            provider: sel.provider,
                            model: sel.model,
                            reasoning: sel.reasoning as ReasoningLevel | undefined,
                        },
                        selection
                    );
                    return (
                        <button
                            key={name}
                            type="button"
                            onMouseDown={(e) => {
                                e.preventDefault();
                                onPick({
                                    provider: sel.provider,
                                    model: sel.model,
                                    reasoning: sel.reasoning as ReasoningLevel | undefined,
                                });
                            }}
                            className={cn(
                                "inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 font-sans transition-colors",
                                isActive
                                    ? "border-accent/60 bg-accent/15 text-foreground"
                                    : "border-fg-overlay-3 bg-fg-overlay-1/60 text-foreground/80 hover:bg-fg-overlay-2/60"
                            )}
                            style={{ fontSize: `${HEADER_FONT_PX + 1}px` }}
                            title={profileSubtitle(sel)}
                        >
                            <UIcon name="stars-01" size={ICON_PX - 2} />
                            <span className="font-medium">{name}</span>
                        </button>
                    );
                })}
            </div>
        </div>
    );
});
ProfilesStrip.displayName = "ProfilesStrip";

// =========================================================================
// TabBar — warp-style inline menu header
// =========================================================================
//
// Layout (mirrors warp inline_menu/view.rs render_header):
//
//   ┌──────────────────────────────────────────────────────────────────────┐
//   │ /MODEL │ ★ Pinned │ OpenRouter │ Anthropic │ ... │ ⟳ │ ⚙ Manage     │
//   └──────────────────────────────────────────────────────────────────────┘
//      ↑          ↑                                       ↑       ↑
//   label   tab pills (active = bg highlight)        refresh   trailing
//
// Differences from warp:
//   - Drag indicator omitted (crest doesn't expose a resize affordance).
//   - "Manage" action is wired to the AI setup wizard (which is also the
//     write path the user would use to add a new provider — same role as
//     warp's "Manage defaults" jumping to settings).
//   - Refresh icon updates catalog facts and provider availability.

const HEADER_BAR_HEIGHT_PX = 36;

interface TabBarProps {
    tabs: TabSpec[];
    activeTab: string;
    onTabClick: (tab: TabSpec) => void;
    showRefresh: boolean;
    refreshing: boolean;
    onRefresh: () => void;
    commandLabel?: string;
    // mousedown on the drag handle starts a resize drag of the menu
    // body height. Wired by the inline picker; popover leaves it
    // undefined and no handle renders.
    onResizeStart?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

interface TabButtonsProps {
    tabs: TabSpec[];
    activeTab: string;
    onTabClick: (tab: TabSpec) => void;
}

const TabButtons = memo(({ tabs, activeTab, onTabClick }: TabButtonsProps) => {
    return (
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto no-scrollbar">
            {tabs.map((tab) => {
                const isActive = tab.id === activeTab;
                const isAdd = tab.kind === "add";
                return (
                    <button
                        key={tab.id}
                        type="button"
                        onMouseDown={(e) => {
                            e.preventDefault();
                            onTabClick(tab);
                        }}
                        className={cn(
                            "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-3 py-1 font-sans font-semibold transition-colors",
                            isActive
                                ? "bg-fg-overlay-2 text-foreground"
                                : isAdd
                                  ? "border border-dashed border-fg-overlay-3 text-secondary/80 hover:border-fg-overlay-3 hover:bg-fg-overlay-2/45 hover:text-foreground/95"
                                  : "text-secondary/80 hover:bg-fg-overlay-2/45 hover:text-foreground/95"
                        )}
                        style={{
                            fontSize: `${SEARCH_FONT_PX}px`,
                            // Dashed border on +Add pulls the content inward
                            // 1px on each side; compensate so the pill heights
                            // still match.
                            ...(isAdd ? { paddingTop: 3, paddingBottom: 3 } : {}),
                        }}
                    >
                        {tab.icon}
                        <span>{tab.label}</span>
                    </button>
                );
            })}
        </div>
    );
});
TabButtons.displayName = "TabButtons";

interface RefreshButtonProps {
    showRefresh: boolean;
    refreshing: boolean;
    onRefresh: () => void;
}

const RefreshButton = memo(({ showRefresh, refreshing, onRefresh }: RefreshButtonProps) => {
    if (!showRefresh) return null;
    return (
        <button
            type="button"
            onMouseDown={(e) => {
                e.preventDefault();
                onRefresh();
            }}
            title="Refresh model list"
            className={cn(
                "inline-flex shrink-0 cursor-pointer items-center justify-center rounded p-1 text-secondary/75 hover:bg-fg-overlay-2/55 hover:text-foreground",
                refreshing && "animate-spin text-foreground/90"
            )}
        >
            <UIcon name="refresh-cw-04" size={ICON_PX - 1} />
        </button>
    );
});
RefreshButton.displayName = "RefreshButton";

const TabBar = memo(
    ({
        tabs,
        activeTab,
        onTabClick,
        showRefresh,
        refreshing,
        onRefresh,
        commandLabel = "/MODEL",
        onResizeStart,
    }: TabBarProps) => {
        return (
            <div
                className="relative flex items-center border-y border-fg-overlay-2/60 bg-fg-overlay-1/55 px-3"
                style={{ height: `${HEADER_BAR_HEIGHT_PX}px` }}
            >
                {/* Left section: /MODEL label + tab pills. Natural
                    width — the drag handle floats above this row at
                    the header's geometric center via absolute
                    positioning, so its X stays fixed when the right-
                    hand refresh button toggles in and out. */}
                <div className="flex min-w-0 items-center gap-3">
                    {commandLabel && (
                        <span
                            className="shrink-0 font-mono uppercase tracking-wider text-foreground/90"
                            style={{ fontSize: `${HEADER_FONT_PX + 1}px` }}
                        >
                            {commandLabel}
                        </span>
                    )}
                    <TabButtons tabs={tabs} activeTab={activeTab} onTabClick={onTabClick} />
                </div>

                {/* Right section: refresh. Pushed to the far right via
                    ml-auto so the drag handle (absolutely positioned
                    below) doesn't displace it. */}
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    <RefreshButton showRefresh={showRefresh} refreshing={refreshing} onRefresh={onRefresh} />
                </div>

                {/* Drag handle, absolutely anchored to the header's
                    geometric center. Stays put when the refresh button
                    toggles on the right or the tab strip widens on the
                    left. pointer-events:none on the wrapper lets clicks
                    fall through except on the actual button. */}
                {onResizeStart && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                        <button
                            type="button"
                            onMouseDown={onResizeStart}
                            title="Drag to resize menu height"
                            aria-label="Resize menu"
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
        );
    }
);
TabBar.displayName = "TabBar";

// =========================================================================
// TabContent — renders rows + per-tab loading / empty states
// =========================================================================

interface TabContentProps {
    tab: TabSpec | undefined;
    rows: PickRow[];
    allRowsCount: number;
    query: string;
    liveState: { status: string; error?: string; fetchedAt: number | null };
    userConfig: AIUserConfig | null;
    selection: AgentSelection | null;
    selectedIdx: number;
    // sidecarMode=true means a detail panel is rendered alongside the
    // list — suppress per-row Tooltip and inline ReasoningSubRow so the
    // sidecar owns those affordances.
    sidecarMode?: boolean;
    onHover: (idx: number) => void;
    onPick: (row: PickRow) => void;
    onPickReasoning: (row: PickRow, level: ReasoningLevel) => void;
    onPinToggle: (row: PickRow) => void;
}

const TabContent = memo(
    ({
        tab,
        rows,
        allRowsCount,
        query,
        liveState,
        userConfig,
        selection,
        selectedIdx,
        sidecarMode,
        onHover,
        onPick,
        onPickReasoning,
        onPinToggle,
    }: TabContentProps) => {
        if (!tab) return null;

        // Provider tab errors live above the list so the user can still
        // pick the cached/catalog fallback rows visible below.
        const showProviderError = tab.kind === "provider" && liveState.status === "error" && liveState.error;

        const showLoading = tab.kind === "provider" && liveState.status === "loading" && rows.length === 0;

        const pinnedEmpty = tab.kind === "pinned" && allRowsCount === 0;

        return (
            <div>
                {showProviderError && (
                    <div
                        className="border-b border-rose-500/40 bg-rose-500/10 px-3 py-2 font-sans text-rose-300"
                        style={{ fontSize: `${HEADER_FONT_PX + 1}px` }}
                    >
                        <div className="font-semibold">Couldn't load models</div>
                        <div className="mt-0.5 text-rose-200/80">{liveState.error}</div>
                    </div>
                )}
                {showLoading && (
                    <div
                        className="px-3 py-6 text-center font-sans text-secondary/70"
                        style={{ fontSize: `${SEARCH_FONT_PX}px` }}
                    >
                        Loading models…
                    </div>
                )}
                {pinnedEmpty && (
                    <div
                        className="px-3 py-6 text-center font-sans text-secondary/70"
                        style={{ fontSize: `${SEARCH_FONT_PX}px` }}
                    >
                        No pinned models yet — open a provider tab and tap{" "}
                        <Pin
                            size={ICON_PX - 1}
                            strokeWidth={2}
                            className="inline-block align-text-bottom text-secondary/85"
                        />{" "}
                        on a model to pin it here.
                    </div>
                )}
                {rows.length === 0 && allRowsCount > 0 && (
                    <div
                        className="px-3 py-4 text-center font-sans text-secondary/75"
                        style={{ fontSize: `${SEARCH_FONT_PX}px` }}
                    >
                        No models match "{query}"
                    </div>
                )}
                {rows.map((row, idx) => {
                    const isSelected = sameSelection(row.selection, selection);
                    const showReasoningRow =
                        !sidecarMode && isSelected && row.reasoningLevels && row.reasoningLevels.length > 0;
                    const pinned = isPinned(userConfig, row.selection.provider, row.selection.model);
                    return (
                        <div key={row.key}>
                            <PickerRow
                                row={row}
                                idx={idx}
                                active={idx === selectedIdx}
                                selected={isSelected}
                                pinned={pinned}
                                showProviderBadge={tab.kind === "pinned"}
                                sidecarMode={sidecarMode}
                                onHover={onHover}
                                onPick={() => onPick(row)}
                                onPinToggle={() => onPinToggle(row)}
                            />
                            {showReasoningRow && (
                                <ReasoningSubRow
                                    levels={row.reasoningLevels!}
                                    current={selection?.reasoning}
                                    onPick={(lvl) => onPickReasoning(row, lvl)}
                                />
                            )}
                        </div>
                    );
                })}
            </div>
        );
    }
);
TabContent.displayName = "TabContent";

// =========================================================================
// PickerRow
// =========================================================================

interface PickerRowProps {
    row: PickRow;
    idx: number;
    active: boolean;
    selected: boolean;
    pinned: boolean;
    showProviderBadge: boolean;
    // sidecarMode=true means details are shown in a panel to the right —
    // suppress the per-row Tooltip so they don't fight for hover focus.
    sidecarMode?: boolean;
    onHover: (idx: number) => void;
    onPick: () => void;
    onPinToggle: () => void;
}

const PickerRow = memo(
    ({
        row,
        idx,
        active,
        selected,
        pinned,
        showProviderBadge,
        sidecarMode,
        onHover,
        onPick,
        onPinToggle,
    }: PickerRowProps) => {
        // Pin chip stays out of the layout when neither hovered nor
        // pinned — that's what the user expects ("only show on hover").
        // We reserve its slot with a placeholder so the check icon
        // column doesn't shift when the user mouses across rows.
        const showPin = row.pinnable && (active || pinned);
        const labelButton = (
            <button
                type="button"
                onMouseDown={(e) => {
                    e.preventDefault();
                    onPick();
                }}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
            >
                <UIcon
                    name={row.icon}
                    size={ICON_PX}
                    className={cn("shrink-0", active ? "text-foreground/95" : "text-secondary/80")}
                />
                <span className="flex min-w-0 flex-1 flex-col text-left">
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
                            {showProviderBadge && <span className="text-secondary/85">{row.providerId} · </span>}
                            {row.subtitle}
                        </span>
                    )}
                </span>
            </button>
        );
        return (
            <div
                data-row-idx={idx}
                onMouseEnter={() => onHover(idx)}
                className={cn(
                    "flex w-full items-center gap-1.5 pl-3 pr-1.5 py-1.5 text-left transition-colors",
                    active ? "bg-fg-overlay-2/70" : "hover:bg-fg-overlay-1",
                    row.needsCredentials && "opacity-55"
                )}
            >
                {sidecarMode ? (
                    labelButton
                ) : (
                    <Tooltip
                        placement="left"
                        openDelay={350}
                        divClassName="flex min-w-0 flex-1"
                        content={<ModelDetailCard row={row} />}
                    >
                        {labelButton}
                    </Tooltip>
                )}
                {row.needsCredentials && (
                    <span
                        className="shrink-0 rounded border border-amber-400/40 bg-amber-500/10 px-1 py-0 font-sans uppercase tracking-wider text-amber-300"
                        style={{ fontSize: "9px" }}
                    >
                        Add key
                    </span>
                )}
                {showPin ? (
                    <button
                        type="button"
                        onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onPinToggle();
                        }}
                        title={pinned ? "Unpin model" : "Pin model"}
                        className={cn(
                            "shrink-0 cursor-pointer rounded p-0.5 transition-colors",
                            pinned
                                ? "text-[var(--ansi-yellow)] hover:bg-fg-overlay-2/60"
                                : "text-secondary/50 hover:bg-fg-overlay-2/60 hover:text-foreground/85"
                        )}
                    >
                        <Pin size={ICON_PX - 1} strokeWidth={2} fill={pinned ? "currentColor" : "none"} />
                    </button>
                ) : row.pinnable ? (
                    <span className="inline-block shrink-0" style={{ width: `${ICON_PX + 3}px` }} />
                ) : null}
                {selected && <UIcon name="check" size={ICON_PX} className="shrink-0 text-[var(--ansi-green)]" />}
            </div>
        );
    }
);
PickerRow.displayName = "PickerRow";

// =========================================================================
// ReasoningSubRow
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
// SearchBar + HintFooter
// =========================================================================

interface SearchBarProps {
    inputRef: React.RefObject<HTMLInputElement>;
    value: string;
    onChange: (v: string) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    placeholder: string;
}

const SearchBar = memo(({ inputRef, value, onChange, onKeyDown, placeholder }: SearchBarProps) => (
    <div
        className="mx-3 my-2 flex cursor-text items-center gap-2 rounded-xl bg-white/[0.045] px-3 py-2"
        onClick={() => {
            // Padding / icon clicks should still focus the input. onClick
            // (not onMouseDown) lets the native click reach the input
            // first; we only step in when the click landed on a sibling.
            if (document.activeElement !== inputRef.current) {
                inputRef.current?.focus();
            }
        }}
    >
        <UIcon name="search" size={ICON_PX - 1} className="shrink-0 text-secondary/60" />
        <input
            ref={inputRef}
            type="text"
            autoFocus
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            className="w-full bg-transparent font-sans text-foreground outline-none placeholder:text-secondary/55"
            style={{ fontSize: `${SEARCH_FONT_PX}px` }}
        />
    </div>
));
SearchBar.displayName = "SearchBar";

const HintFooter = memo(({ showTabHint }: { showTabHint: boolean }) => (
    <div
        className="flex items-center gap-x-3 border-t border-white/[0.06] px-3 py-2 font-sans text-secondary/65"
        style={{ fontSize: `${HEADER_FONT_PX + 1}px` }}
    >
        <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">
                ↑
            </kbd>
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">
                ↓
            </kbd>
            <span>navigate</span>
        </span>
        {showTabHint && (
            <span className="inline-flex items-center gap-1.5">
                <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">
                    ⇥
                </kbd>
                <span>switch tab</span>
            </span>
        )}
        <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1">
                ↵
            </kbd>
            <span>select</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
            <kbd className="inline-flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] bg-fg-overlay-2/70 px-1.5">
                esc
            </kbd>
            <span>dismiss</span>
        </span>
    </div>
));
HintFooter.displayName = "HintFooter";

// =========================================================================
// ModelDetailCard — fuller, hover-only model info
// =========================================================================

const ModelDetailCard = memo(({ row }: { row: PickRow }) => {
    const d = row.detail;
    const ctxLabel = d.contextWindow ? `${d.contextWindow.toLocaleString()} tokens` : undefined;
    return (
        <div className="max-w-[320px] font-sans">
            <div className="font-semibold text-foreground" style={{ fontSize: `${SEARCH_FONT_PX}px` }}>
                {row.displayName}
            </div>
            <div className="mt-0.5 font-mono text-secondary/75" style={{ fontSize: `${HEADER_FONT_PX + 1}px` }}>
                {d.providerLabel} · {d.modelId}
            </div>
            {d.description && (
                <div
                    className="mt-2 text-foreground/85 whitespace-pre-line"
                    style={{ fontSize: `${HEADER_FONT_PX + 1}px`, lineHeight: 1.45 }}
                >
                    {d.description}
                </div>
            )}
            <div className="mt-2 flex flex-col gap-0.5" style={{ fontSize: `${HEADER_FONT_PX + 1}px` }}>
                {ctxLabel && <DetailRow label="Context window" value={ctxLabel} />}
                {d.capabilities && d.capabilities.length > 0 && (
                    <DetailRow label="Capabilities" value={d.capabilities.join(", ")} />
                )}
                {d.reasoningLevels && d.reasoningLevels.length > 0 && (
                    <DetailRow label="Reasoning" value={d.reasoningLevels.join(", ")} />
                )}
            </div>
            {row.needsCredentials && (
                <div
                    className="mt-2 rounded border border-amber-400/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-200"
                    style={{ fontSize: `${HEADER_FONT_PX + 1}px` }}
                >
                    Add an API key for {d.providerLabel} to use this model.
                </div>
            )}
        </div>
    );
});
ModelDetailCard.displayName = "ModelDetailCard";

const DetailRow = memo(({ label, value }: { label: string; value: string }) => (
    <div className="flex items-baseline gap-2">
        <span className="shrink-0 uppercase tracking-wider text-secondary/65" style={{ minWidth: 72 }}>
            {label}
        </span>
        <span className="min-w-0 break-words text-foreground/90">{value}</span>
    </div>
));
DetailRow.displayName = "DetailRow";

// =========================================================================
// SidecarPanel — right pane that mirrors warp's hover-sidecar pattern.
// Renders details for the currently-hovered row (description, context,
// capabilities) plus an inline reasoning-level picker when the model
// supports reasoning. Clicking a reasoning chip commits the selection
// with that level — same behaviour the old ReasoningSubRow had.
// =========================================================================

interface SidecarPanelProps {
    row: PickRow | undefined;
    currentReasoning?: ReasoningLevel;
    // When true (Pinned tab, cross-provider context), the sidecar
    // surfaces the provider label as a small chip. When false (the
    // active tab already represents the provider) it is suppressed.
    showProvider: boolean;
    onPickReasoning: (row: PickRow, level: ReasoningLevel) => void;
}

const SIDECAR_FONT_PX = 12;
const SIDECAR_SECTION_FONT_PX = 10;

const SidecarPanel = memo(({ row, currentReasoning, showProvider, onPickReasoning }: SidecarPanelProps) => {
    if (!row) {
        return (
            <div
                className="flex h-full items-center justify-center px-4 py-6 text-center font-sans text-secondary/60"
                style={{ fontSize: `${SIDECAR_FONT_PX}px` }}
            >
                Hover a model to see details
            </div>
        );
    }
    const d = row.detail;
    const ctxLabel = d.contextWindow ? formatTokenCount(d.contextWindow) : undefined;
    const outputLabel =
        d.maxOutputTokens && d.maxOutputTokens !== d.contextWindow ? formatTokenCount(d.maxOutputTokens) : undefined;
    const promptPrice = formatPricePerMillion(d.promptCostPerToken);
    const completionPrice = formatPricePerMillion(d.completionCostPerToken);
    const imagePrice = formatImagePrice(d.imageCostPerImage);
    const hasPricing = !!(promptPrice || completionPrice || imagePrice);
    const modalityLabel = formatModalities(d.inputModalities);

    return (
        <div
            className="flex h-full flex-col gap-3 overflow-y-auto px-4 py-3 font-sans"
            style={{ fontSize: `${SIDECAR_FONT_PX}px` }}
        >
            <div className="flex flex-col gap-1">
                <div className="font-semibold text-foreground" style={{ fontSize: "14px", lineHeight: 1.3 }}>
                    {row.displayName}
                </div>
                <div
                    className="break-all font-mono text-secondary/80"
                    style={{ fontSize: `${SIDECAR_FONT_PX - 1}px`, lineHeight: 1.4 }}
                >
                    {d.modelId}
                </div>
                {showProvider && (
                    <div className="mt-1 inline-flex">
                        <span
                            className="rounded border border-fg-overlay-3 bg-fg-overlay-2/40 px-1.5 py-0.5 font-sans text-foreground/85"
                            style={{ fontSize: `${SIDECAR_SECTION_FONT_PX}px` }}
                        >
                            {d.providerLabel}
                        </span>
                    </div>
                )}
            </div>

            {d.description && <SidecarDescription text={d.description} rowKey={row.key} />}

            {d.reasoningLevels && d.reasoningLevels.length > 0 && (
                <SidecarSection label="Reasoning">
                    <div className="flex flex-wrap gap-1.5">
                        {d.reasoningLevels.map((lvl) => (
                            <button
                                key={lvl}
                                type="button"
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    onPickReasoning(row, lvl);
                                }}
                                className={cn(
                                    "cursor-pointer rounded border px-2.5 py-0.5 font-sans capitalize transition-colors",
                                    currentReasoning === lvl
                                        ? "border-[var(--ansi-yellow)]/60 bg-[var(--ansi-yellow)]/15 text-[var(--ansi-yellow)]"
                                        : "border-fg-overlay-2/60 bg-transparent text-foreground/80 hover:bg-fg-overlay-2/60"
                                )}
                                style={{ fontSize: `${SIDECAR_FONT_PX}px` }}
                            >
                                {lvl}
                            </button>
                        ))}
                    </div>
                </SidecarSection>
            )}

            {hasPricing && (
                <SidecarSection label="Pricing">
                    <div className="grid grid-cols-2 gap-1.5">
                        {promptPrice && <PriceCard label="Prompt" {...splitPrice(promptPrice)} />}
                        {completionPrice && <PriceCard label="Output" {...splitPrice(completionPrice)} />}
                        {imagePrice && <PriceCard label="Image" {...splitPrice(imagePrice)} />}
                    </div>
                </SidecarSection>
            )}

            <SidecarSection label="Details">
                {/* Tailwind arbitrary grid template needs underscores
                        for spaces — `[auto_1fr]`, not `[auto,1fr]` — or
                        the columns collapse to a single column. */}
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    {ctxLabel && <DetailKV label="Context" value={ctxLabel} />}
                    {outputLabel && <DetailKV label="Max output" value={outputLabel} />}
                    {modalityLabel && <DetailKV label="Modality" value={modalityLabel} />}
                    {d.capabilities && d.capabilities.length > 0 && (
                        <DetailKV label="Capabilities" value={d.capabilities.join(", ")} />
                    )}
                    {d.tokenizer && <DetailKV label="Tokenizer" value={d.tokenizer} />}
                    {d.isModerated && <DetailKV label="Moderated" value="Yes" />}
                </div>
            </SidecarSection>

            {row.needsCredentials && (
                <div
                    className="rounded border border-amber-400/40 bg-amber-500/10 px-2 py-1.5 text-amber-200"
                    style={{ fontSize: `${SIDECAR_FONT_PX}px` }}
                >
                    Add an API key for {d.providerLabel} to use this model.
                </div>
            )}
        </div>
    );
});
SidecarPanel.displayName = "SidecarPanel";

// SidecarDescription — collapsible description block. Defaults to a
// 5-line clamp (so pricing / details stay visible without the user
// having to scroll), with a "Show more" toggle that expands it. The
// `rowKey` prop resets the expanded state whenever the user hovers a
// different model so descriptions don't bleed across rows.
const COLLAPSED_DESC_MAX_HEIGHT_PX = 90;
const EXPANDED_DESC_MAX_HEIGHT_PX = 240;

const SidecarDescription = memo(({ text, rowKey }: { text: string; rowKey: string }) => {
    const [expanded, setExpanded] = useState(false);
    const [overflows, setOverflows] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        setExpanded(false);
    }, [rowKey]);

    // Track DOM-level overflow continuously. ResizeObserver catches the
    // post-paint settle that the synchronous measurement on mount
    // sometimes misses (fonts loading, layout reflow). Re-runs whenever
    // text changes or the collapsed/expanded state toggles.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measure = () => {
            // Tolerance of 2px swallows subpixel rounding without
            // flickering the button for descriptions that fit exactly.
            setOverflows(el.scrollHeight > el.clientHeight + 2);
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [text, expanded]);

    // Only render the toggle when collapsed-and-actually-overflows OR
    // when already expanded (so "Show less" is reachable). No char-length
    // heuristic — that gave false positives for tight-wrapping
    // descriptions where expanding didn't reveal anything new.
    const showToggle = expanded || overflows;

    // Subtle fade at the bottom of the collapsed box stands in for the
    // dropped line-clamp `…` ellipsis — same "there's more" signal
    // without relying on -webkit-line-clamp (whose interaction with
    // scrollHeight in Blink is browser-version dependent).
    const fadeMask =
        !expanded && overflows ? "linear-gradient(to bottom, black calc(100% - 18px), transparent)" : undefined;

    return (
        <div>
            <div
                ref={ref}
                className="whitespace-pre-line pr-1 text-foreground/85"
                style={{
                    fontSize: `${SIDECAR_FONT_PX}px`,
                    lineHeight: 1.5,
                    maxHeight: expanded ? `${EXPANDED_DESC_MAX_HEIGHT_PX}px` : `${COLLAPSED_DESC_MAX_HEIGHT_PX}px`,
                    overflowY: expanded ? "auto" : "hidden",
                    maskImage: fadeMask,
                    WebkitMaskImage: fadeMask,
                }}
            >
                {text}
            </div>
            {showToggle && (
                <button
                    type="button"
                    onMouseDown={(e) => {
                        e.preventDefault();
                        setExpanded((v) => !v);
                    }}
                    className="mt-1 cursor-pointer font-sans font-medium text-[var(--ansi-blue)] hover:underline"
                    style={{ fontSize: `${SIDECAR_FONT_PX - 1}px` }}
                >
                    {expanded ? "Show less" : "Show more"}
                </button>
            )}
        </div>
    );
});
SidecarDescription.displayName = "SidecarDescription";

const SidecarSection = memo(({ label, children }: { label: string; children: React.ReactNode }) => (
    <div className="flex flex-col gap-2">
        {/* Section header sits inside a thin divider so it reads as
                a real separator instead of competing with the per-row
                uppercase labels (PROMPT / OUTPUT / IMAGE) inside the
                pricing cards below. */}
        <div className="flex items-center gap-2">
            <span
                className="font-sans font-semibold uppercase tracking-[0.12em] text-foreground/85"
                style={{ fontSize: `${SIDECAR_SECTION_FONT_PX + 1}px` }}
            >
                {label}
            </span>
            <span className="h-px flex-1 bg-fg-overlay-2/70" />
        </div>
        {children}
    </div>
));
SidecarSection.displayName = "SidecarSection";

// PriceCard — pricing renders as small "stat cards" so dollar amounts
// pop visually and aren't confused with the plain-text details rows.
// 2-up grid; each card is uppercase label + big mono amount + tiny
// "per 1M tokens" / "per image" suffix.
const PriceCard = memo(({ label, amount, suffix }: { label: string; amount: string; suffix?: string }) => (
    <div className="rounded-md border border-fg-overlay-3/60 bg-fg-overlay-2/25 px-2 py-1.5">
        <div
            className="font-sans uppercase tracking-wider text-secondary/65"
            style={{ fontSize: `${SIDECAR_SECTION_FONT_PX}px` }}
        >
            {label}
        </div>
        <div className="font-mono font-semibold text-foreground" style={{ fontSize: "13px", lineHeight: 1.2 }}>
            {amount}
        </div>
        {suffix && (
            <div
                className="font-sans text-secondary/65"
                style={{ fontSize: `${SIDECAR_SECTION_FONT_PX}px`, lineHeight: 1.3 }}
            >
                {suffix}
            </div>
        )}
    </div>
));
PriceCard.displayName = "PriceCard";

// DetailKV — details renders as a compact 2-column grid (label · value)
// so it visually contrasts with the boxed pricing cards above.  The
// parent owns the grid so labels and values share an alignment column.
const DetailKV = memo(({ label, value }: { label: string; value: string }) => (
    <>
        <div className="text-secondary/70" style={{ fontSize: `${SIDECAR_FONT_PX}px`, lineHeight: 1.4 }}>
            {label}
        </div>
        <div
            className="min-w-0 break-words font-medium text-foreground/95"
            style={{ fontSize: `${SIDECAR_FONT_PX}px`, lineHeight: 1.4 }}
        >
            {value}
        </div>
    </>
));
DetailKV.displayName = "DetailKV";

// splitPrice turns "$3.00 / 1M" → { amount: "$3.00", suffix: "per 1M tokens" }
// or "Free" → { amount: "Free" }. Suffix uses the more readable
// "per X" phrasing for the stat-card layout.
function splitPrice(formatted: string): { amount: string; suffix?: string } {
    if (formatted === "Free") return { amount: "Free" };
    const slashIdx = formatted.lastIndexOf(" / ");
    if (slashIdx < 0) return { amount: formatted };
    const amount = formatted.slice(0, slashIdx).trim();
    const tail = formatted.slice(slashIdx + 3).trim();
    let suffix: string;
    if (tail === "1M") suffix = "per 1M tokens";
    else if (tail === "1k") suffix = "per 1k images";
    else if (tail === "image") suffix = "per image";
    else suffix = `per ${tail}`;
    return { amount, suffix };
}

// Format helpers used by the sidecar. Live OpenRouter prices arrive as
// per-token USD floats — display as $/1M tokens (common upstream
// pricing unit). Token counts collapse to 200k / 1M / 1.2M style.
function formatTokenCount(tokens: number): string {
    if (tokens >= 1_000_000) {
        const m = tokens / 1_000_000;
        return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
    }
    if (tokens >= 1_000) {
        return `${Math.round(tokens / 1_000)}k`;
    }
    return tokens.toString();
}

function formatPricePerMillion(usdPerToken: number | undefined): string | null {
    if (usdPerToken == null) return null;
    if (usdPerToken === 0) return "Free";
    const perMillion = usdPerToken * 1_000_000;
    if (perMillion < 0.01) return `$${perMillion.toFixed(4)} / 1M`;
    if (perMillion < 10) return `$${perMillion.toFixed(2)} / 1M`;
    return `$${perMillion.toFixed(2)} / 1M`;
}

function formatImagePrice(usdPerImage: number | undefined): string | null {
    if (!usdPerImage) return null;
    if (usdPerImage < 0.001) return `$${(usdPerImage * 1000).toFixed(3)} / 1k`;
    return `$${usdPerImage.toFixed(4)} / image`;
}

function formatModalities(mods: string[] | undefined): string | null {
    if (!mods || mods.length === 0) return null;
    return mods.map((m) => m.charAt(0).toUpperCase() + m.slice(1)).join(" + ");
}

// =========================================================================
// Tab + row construction
// =========================================================================

function buildTabs(configuredProviders: string[], userConfig: AIUserConfig | null): TabSpec[] {
    const out: TabSpec[] = [];
    out.push({
        id: "pinned",
        kind: "pinned",
        label: "Pinned",
        // lucide-react Pin component (ISC). Filled via fill prop so
        // the Pinned tab reads as "active pin" without needing a
        // separate filled variant icon.
        icon: <Pin size={ICON_PX - 2} fill="currentColor" strokeWidth={2} />,
    });
    for (const pid of configuredProviders) {
        out.push({
            id: pid,
            kind: "provider",
            providerId: pid,
            label: providerDisplayName(pid, userConfig),
            icon: <UIcon name={providerIcon(pid, userConfig)} size={ICON_PX - 2} />,
        });
    }
    // "+ Add" trailing pseudo-tab opens the AI setup wizard, which
    // since this round only shows providers the user hasn't configured
    // yet — so it really is an "add new provider" entry point.
    out.push({
        id: "__add",
        kind: "add",
        label: "Add",
        icon: <UIcon name="plus" size={ICON_PX - 2} />,
    });
    return out;
}

function buildPinnedRows(catalog: ProviderEntry[], userConfig: AIUserConfig | null): PickRow[] {
    const pins = userConfig?.pinned ?? [];
    if (pins.length === 0) return [];
    const credsByProvider = userConfig?.providers ?? {};
    return pins.map((pin) => {
        const provider = catalog.find((p) => p.id === pin.provider);
        const customEp = userConfig?.custom_endpoints?.[pin.provider];
        const catalogModel = provider?.models.find((model) => model.id === pin.model);
        const customModel = userConfig?.custom_models?.find((m) => m.provider === pin.provider && m.id === pin.model);
        const endpointModel = customEp?.models.find((m) => m.id === pin.model);
        const displayName =
            catalogModel?.displayName ?? customModel?.displayname ?? endpointModel?.displayName ?? pin.model;
        const icon = provider?.icon ?? (customEp?.icon || "code-02");
        const subtitle =
            (catalogModel && modelSubtitle(catalogModel)) ||
            (customModel && customModelSubtitle(customModel)) ||
            (endpointModel && endpointModelSubtitle(endpointModel, customEp?.endpoint ?? "")) ||
            "";
        const reasoningLevels =
            (catalogModel?.reasoningLevels as ReasoningLevel[] | undefined) ??
            (customModel?.reasoninglevels as ReasoningLevel[] | undefined) ??
            (endpointModel?.reasoningLevels as ReasoningLevel[] | undefined);
        const detail: ModelDetail = {
            modelId: pin.model,
            providerLabel: providerDisplayName(pin.provider, userConfig),
            description: catalogModel?.description ?? customModel?.description ?? endpointModel?.description,
            contextWindow: catalogModel?.contextWindow ?? customModel?.contextwindow ?? endpointModel?.contextWindow,
            capabilities:
                catalogModel?.capabilities ??
                (customModel?.capabilities as Capability[] | undefined) ??
                (endpointModel?.capabilities as Capability[] | undefined),
            reasoningLevels,
        };
        return {
            key: `pin-${pin.provider}-${pin.model}`,
            selection: { provider: pin.provider, model: pin.model },
            displayName,
            subtitle,
            icon,
            providerId: pin.provider,
            needsCredentials: !credsByProvider[pin.provider],
            reasoningLevels,
            pinnable: true,
            detail,
        };
    });
}

function buildProviderRows(
    providerId: string,
    catalog: ProviderEntry[],
    userConfig: AIUserConfig | null,
    liveModels: ProviderModelInfoLite[] | null
): PickRow[] {
    const provider = catalog.find((entry) => entry.id === providerId);
    const customEp = userConfig?.custom_endpoints?.[providerId];
    const hasCreds = !!userConfig?.providers?.[providerId];
    const icon = provider?.icon ?? customEp?.icon ?? "code-02";

    // Map of model id → catalog metadata for capability/context enrichment.
    const catalogByModelId = new Map<string, ModelEntry>();
    for (const m of provider?.models ?? []) catalogByModelId.set(m.id, m);

    // Same for user-defined custom_models attached to this provider.
    const customByModelId = new Map<string, UserCustomModel>();
    for (const m of userConfig?.custom_models ?? []) {
        if (m.provider === providerId) customByModelId.set(m.id, m);
    }

    // Endpoint-level model defs (for user custom_endpoints).
    const endpointByModelId = new Map<string, UserCustomEndpointModel>();
    for (const m of customEp?.models ?? []) endpointByModelId.set(m.id, m);

    // `/models` contributes account/deployment visibility only. Catalog
    // metadata remains authoritative for every known ID.
    const ids = new Set<string>();
    if (liveModels && liveModels.length > 0) {
        for (const m of liveModels) ids.add(m.id);
    } else {
        for (const m of provider?.models ?? []) ids.add(m.id);
        for (const m of customByModelId.keys()) ids.add(m);
        for (const m of endpointByModelId.keys()) ids.add(m);
    }

    const liveById = new Map<string, ProviderModelInfoLite>();
    for (const m of liveModels ?? []) liveById.set(m.id, m);

    const out: PickRow[] = [];
    for (const id of ids) {
        const live = liveById.get(id);
        const cat = catalogByModelId.get(id);
        const custom = customByModelId.get(id);
        const endpointDef = endpointByModelId.get(id);

        const displayName = cat?.displayName ?? custom?.displayname ?? endpointDef?.displayName ?? live?.name ?? id;
        const context = cat?.contextWindow ?? custom?.contextwindow ?? endpointDef?.contextWindow ?? 0;
        const capabilities: Capability[] =
            cat?.capabilities ??
            (custom?.capabilities as Capability[] | undefined) ??
            (endpointDef?.capabilities as Capability[] | undefined) ??
            [];
        const reasoningLevels =
            (cat?.reasoningLevels as ReasoningLevel[] | undefined) ??
            (custom?.reasoninglevels as ReasoningLevel[] | undefined) ??
            (endpointDef?.reasoningLevels as ReasoningLevel[] | undefined);

        out.push({
            key: `model-${providerId}-${id}`,
            selection: { provider: providerId, model: id },
            displayName,
            subtitle: composeSubtitle(context, capabilities),
            icon,
            providerId,
            needsCredentials: !hasCreds,
            reasoningLevels,
            pinnable: true,
            detail: {
                modelId: id,
                providerLabel: providerDisplayName(providerId, userConfig),
                description: cat?.description ?? custom?.description ?? endpointDef?.description,
                contextWindow: context || undefined,
                capabilities,
                reasoningLevels,
            },
        });
    }
    // Stable sort: catalog/custom-known models first (they have nicer
    // metadata), then everything else alphabetically.
    out.sort((a, b) => {
        const aKnown = catalogByModelId.has(a.selection.model) || customByModelId.has(a.selection.model);
        const bKnown = catalogByModelId.has(b.selection.model) || customByModelId.has(b.selection.model);
        if (aKnown !== bKnown) return aKnown ? -1 : 1;
        return a.displayName.localeCompare(b.displayName);
    });
    return out;
}

function composeSubtitle(context: number, capabilities: Capability[], description?: string): string {
    const parts: string[] = [];
    if (context > 0) parts.push(formatContext(context));
    if (capabilities.length > 0) parts.push(capabilities.join(" · "));
    else if (description) parts.push(description);
    return parts.join(" · ");
}

function profileSubtitle(sel: { provider: string; model: string; reasoning?: string }): string {
    const base = `${sel.provider} · ${sel.model}`;
    return sel.reasoning ? `${base} · ${sel.reasoning}` : base;
}

function modelSubtitle(model: ModelEntry): string {
    return composeSubtitle(model.contextWindow, model.capabilities, model.description);
}

function customModelSubtitle(cm: { capabilities: string[]; contextwindow: number; description?: string }): string {
    return composeSubtitle(cm.contextwindow, cm.capabilities as Capability[], cm.description);
}

function endpointModelSubtitle(
    model: { capabilities: string[]; contextWindow: number; description?: string },
    endpoint: string
): string {
    const host = (() => {
        try {
            return new URL(endpoint).host;
        } catch {
            return "";
        }
    })();
    const tail = composeSubtitle(model.contextWindow, model.capabilities as Capability[], model.description);
    return [host, tail].filter(Boolean).join(" · ");
}

function formatContext(tokens: number): string {
    if (!tokens) return "";
    if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M ctx`;
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k ctx`;
    return `${tokens} ctx`;
}

function filterRows(query: string, rows: PickRow[]): PickRow[] {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
        const hay = [r.displayName, r.subtitle, r.selection.provider, r.selection.model]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
        return hay.includes(q);
    });
}

function searchPlaceholder(tab: TabSpec | undefined): string {
    if (!tab) return "Search models";
    if (tab.kind === "pinned") return "Search pinned";
    if (tab.kind === "provider") return `Search ${tab.label}`;
    return "Search models";
}

function sameSelection(a: AgentSelection, b: AgentSelection | null): boolean {
    if (!b) return false;
    return a.provider === b.provider && a.model === b.model && (a.reasoning ?? null) === (b.reasoning ?? null);
}

// =========================================================================
// ModelPickerInline — warp-style inline picker
// =========================================================================
//
// Same content as ModelPickerPopover but rendered *inline* above the input
// card instead of as a floating-portal overlay.  Visual reference:
// warp app/src/terminal/input/agent.rs:241-286 — the inline_model_selector_view
// is added as the top child of the input's Flex::column, taking layout
// space and sharing the input's frame.
//
// Differences vs the popover:
//   - No FloatingPortal / useFloating / useDismiss.
//   - No drop shadow, no rounded outer border; just a top divider that
//     visually merges into the input card's top border.
//   - Full width of the input pane (no fixed POPOVER_WIDTH_PX).
//   - Stays open until Esc / chip toggle / picking a model / `+ Add`.
//     Clicking elsewhere in the app does NOT dismiss — matches warp's
//     "menu mode" semantics.
//
// All sub-components (TabBar, SearchBar, TabContent, ConfigBanner, etc.)
// and helpers (buildTabs, buildPinnedRows, buildProviderRows, filterRows,
// …) are reused verbatim.

export interface ModelPickerInlineProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    selection: AgentSelection | null;
    onSelectionChange: (next: AgentSelection) => void;
    userConfig: AIUserConfig | null;
    userConfigStatus: AIUserConfigStatus;
    userConfigError?: string;
    catalog?: ProviderEntry[];
    onOpenConfigFile?: () => void;
    // Chip the picker is launched from. Outside-click dismissal skips
    // clicks landing on this element, otherwise the chip's onClick
    // toggles the picker back open immediately after dismiss.
    anchorRef?: React.RefObject<HTMLElement>;
}

const INLINE_BODY_HEIGHT_DEFAULT_PX = 360;
const INLINE_BODY_HEIGHT_MIN_PX = 200;
const INLINE_BODY_HEIGHT_MAX_PX = 720;
const INLINE_SIDECAR_WIDTH_PX = 340;

export const ModelPickerInline = memo(
    ({
        open,
        onOpenChange,
        selection,
        onSelectionChange,
        userConfig,
        userConfigStatus,
        userConfigError,
        catalog = CATALOG,
        onOpenConfigFile,
        anchorRef,
    }: ModelPickerInlineProps) => {
        const [query, setQuery] = useState("");
        const [selectedIdx, setSelectedIdx] = useState(0);
        const [activeTab, setActiveTab] = useState<string>("");
        const [bodyHeight, setBodyHeight] = useState(INLINE_BODY_HEIGHT_DEFAULT_PX);
        const searchRef = useRef<HTMLInputElement>(null);
        const listRef = useRef<HTMLDivElement>(null);
        const rootRef = useRef<HTMLDivElement>(null);
        const registryModelsMap = useAtomValue(registryModelsMapAtom);
        const effectiveCatalog = useMemo(
            () => projectRegistryCatalog(catalog, registryModelsMap),
            [catalog, registryModelsMap]
        );

        const configuredProviders = useMemo(() => providersWithCredentials(userConfig), [userConfig]);

        const tabs = useMemo<TabSpec[]>(
            () => buildTabs(configuredProviders, userConfig),
            [configuredProviders, userConfig]
        );

        // Default tab on each open: provider of current selection if
        // configured, else first configured provider, else "pinned".
        useEffect(() => {
            if (!open) return;
            const want =
                (selection && configuredProviders.includes(selection.provider) ? selection.provider : null) ??
                configuredProviders[0] ??
                "pinned";
            setActiveTab((cur) => (tabs.some((t) => t.id === cur) ? cur : want));
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [open]);

        useEffect(() => {
            if (!open) return;
            const tab = tabs.find((t) => t.id === activeTab);
            if (tab?.kind === "provider" && tab.providerId) {
                void Promise.all([
                    fetchRegistryModels(tab.providerId),
                    fetchProviderModels(tab.providerId, userConfig),
                ]);
            }
        }, [open, activeTab, tabs, userConfig]);

        const activeTabSpec = tabs.find((t) => t.id === activeTab);
        const liveAtom = useMemo(
            () => providerModelsAtomFor(activeTabSpec?.providerId ?? ""),
            [activeTabSpec?.providerId]
        );
        const liveState = useAtomValue(liveAtom);

        const rows = useMemo<PickRow[]>(() => {
            if (!activeTabSpec) return [];
            if (activeTabSpec.kind === "pinned") return buildPinnedRows(effectiveCatalog, userConfig);
            if (activeTabSpec.kind === "provider" && activeTabSpec.providerId) {
                return buildProviderRows(
                    activeTabSpec.providerId,
                    effectiveCatalog,
                    userConfig,
                    liveState.status === "ok" ? liveState.models : null
                );
            }
            return [];
        }, [activeTabSpec, effectiveCatalog, userConfig, liveState]);

        const filtered = useMemo(() => filterRows(query, rows), [query, rows]);

        useEffect(() => {
            if (!open) setQuery("");
        }, [open]);

        useEffect(() => {
            const idx = filtered.findIndex((r) => sameSelection(r.selection, selection));
            setSelectedIdx(idx >= 0 ? idx : 0);
        }, [filtered, selection]);

        useEffect(() => {
            if (!open) return;
            const list = listRef.current;
            if (!list) return;
            const row = list.querySelector<HTMLElement>(`[data-row-idx="${selectedIdx}"]`);
            row?.scrollIntoView({ block: "nearest" });
        }, [selectedIdx, open]);

        // Outside-click dismissal — close when a mousedown lands outside
        // both the picker body and the launcher chip. Skipped while a
        // modal (e.g. the AI Setup Wizard launched from the "+ Add"
        // tab) is layered on top; clicks inside that wizard would
        // otherwise look like "outside the picker" and dismiss it.
        useEffect(() => {
            if (!open) return;
            const handler = (e: MouseEvent) => {
                if (globalStore.get(atoms.modalOpen)) return;
                const t = e.target as Node | null;
                if (!t) return;
                if (rootRef.current?.contains(t)) return;
                if (anchorRef?.current?.contains(t)) return;
                onOpenChange(false);
            };
            const keyHandler = (e: KeyboardEvent) => {
                if (globalStore.get(atoms.modalOpen)) return;
                if (e.key !== "Escape") return;
                e.preventDefault();
                e.stopPropagation();
                onOpenChange(false);
            };
            document.addEventListener("mousedown", handler, true);
            window.addEventListener("keydown", keyHandler, true);
            return () => {
                document.removeEventListener("mousedown", handler, true);
                window.removeEventListener("keydown", keyHandler, true);
            };
        }, [open, onOpenChange, anchorRef]);

        const handleTabClick = useCallback(
            (tab: TabSpec) => {
                if (tab.kind === "add") {
                    // Open the wizard but keep the picker open — when
                    // the user closes the wizard, the new provider tab
                    // is already there waiting.
                    onOpenConfigFile?.();
                    return;
                }
                setActiveTab(tab.id);
                setQuery("");
            },
            [onOpenConfigFile]
        );

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

        // Drag-resize the body. mousedown on the handle records the
        // starting Y + height, then a document-level mousemove tracks
        // the delta and clamps to [MIN, MAX]. Negative delta (drag UP)
        // grows the menu because it opens above the input — the user's
        // cursor moves toward where the menu's top edge will end up.
        const handleResizeStart = useCallback(
            (e: React.MouseEvent<HTMLButtonElement>) => {
                e.preventDefault();
                const startY = e.clientY;
                const startHeight = bodyHeight;
                const onMove = (mv: MouseEvent) => {
                    const next = Math.min(
                        INLINE_BODY_HEIGHT_MAX_PX,
                        Math.max(INLINE_BODY_HEIGHT_MIN_PX, startHeight - (mv.clientY - startY))
                    );
                    setBodyHeight(next);
                };
                const onUp = () => {
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
            },
            [bodyHeight]
        );

        const handlePinToggle = useCallback(async (row: PickRow) => {
            try {
                await togglePinned(row.selection.provider, row.selection.model);
            } catch (e) {
                // eslint-disable-next-line no-console
                console.error("toggle pin failed:", e);
            }
        }, []);

        const handleRefresh = useCallback(() => {
            if (activeTabSpec?.kind === "provider" && activeTabSpec.providerId) {
                void Promise.all([
                    refreshRegistryModels(activeTabSpec.providerId),
                    refreshProviderModels(activeTabSpec.providerId, userConfig),
                ]);
            }
        }, [activeTabSpec, userConfig]);

        const cycleTab = useCallback(
            (dir: 1 | -1) => {
                const switchable = tabs.filter((t) => t.kind !== "add");
                if (switchable.length === 0) return;
                const curIdx = switchable.findIndex((t) => t.id === activeTab);
                const nextIdx = (curIdx + dir + switchable.length) % switchable.length;
                setActiveTab(switchable[nextIdx].id);
                setQuery("");
            },
            [tabs, activeTab]
        );

        const handleSearchKey = useCallback(
            (e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Tab") {
                    e.preventDefault();
                    cycleTab(e.shiftKey ? -1 : 1);
                    return;
                }
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
            [filtered, selectedIdx, commitRow, onOpenChange, cycleTab]
        );

        if (!open) return null;

        const showRefresh = activeTabSpec?.kind === "provider";
        const registryState = registryModelsMap[activeTabSpec?.providerId ?? ""];
        const isLoading = showRefresh && (liveState.status === "loading" || registryState?.status === "loading");

        const showSidecarProvider = activeTabSpec?.kind !== "provider";

        return (
            <CommandInlineFrame
                commandName="/model"
                rootRef={rootRef}
                role="listbox"
                headerContent={<TabButtons tabs={tabs} activeTab={activeTab} onTabClick={handleTabClick} />}
                headerActions={
                    <RefreshButton showRefresh={showRefresh} refreshing={isLoading} onRefresh={handleRefresh} />
                }
                onResizeStart={handleResizeStart}
            >
                <ConfigBanner
                    status={userConfigStatus}
                    error={userConfigError}
                    configuredCount={configuredProviders.length}
                    onOpenConfigFile={onOpenConfigFile}
                />

                <ProfilesStrip
                    userConfig={userConfig}
                    selection={selection}
                    onPick={(sel) => {
                        onSelectionChange(sel);
                        onOpenChange(false);
                    }}
                />

                <SearchBar
                    inputRef={searchRef}
                    value={query}
                    onChange={setQuery}
                    onKeyDown={handleSearchKey}
                    placeholder={searchPlaceholder(activeTabSpec)}
                />

                {/* Body: list on the left, sidecar detail panel on the
                    right. Fixed height (not max-height) keeps the picker
                    from jumping when tabs with fewer rows are active.
                    Height is user-resizable via the drag handle in the
                    header — clamped to [MIN, MAX] in handleResizeStart. */}
                <div className="flex" style={{ height: `${bodyHeight}px` }}>
                    <div ref={listRef} className="flex min-w-0 flex-1 flex-col overflow-y-auto">
                        <TabContent
                            tab={activeTabSpec}
                            rows={filtered}
                            allRowsCount={rows.length}
                            query={query}
                            liveState={liveState}
                            userConfig={userConfig}
                            selection={selection}
                            selectedIdx={selectedIdx}
                            sidecarMode={true}
                            onHover={setSelectedIdx}
                            onPick={commitRow}
                            onPickReasoning={commitReasoning}
                            onPinToggle={handlePinToggle}
                        />
                    </div>
                    <div
                        className="shrink-0 border-l border-fg-overlay-2/60 bg-fg-overlay-1/30"
                        style={{ width: `${INLINE_SIDECAR_WIDTH_PX}px` }}
                    >
                        <SidecarPanel
                            row={filtered[selectedIdx]}
                            currentReasoning={selection?.reasoning}
                            showProvider={showSidecarProvider}
                            onPickReasoning={commitReasoning}
                        />
                    </div>
                </div>

                <HintFooter showTabHint={tabs.filter((t) => t.kind !== "add").length > 1} />
            </CommandInlineFrame>
        );
    }
);
ModelPickerInline.displayName = "ModelPickerInline";
