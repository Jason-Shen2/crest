// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CommandInlineFrame } from "@/app/view/cmdblock/command-inline-frame";
import {
    CommandSelectorHintFooter,
    CommandSelectorMessage,
    CommandSelectorPanel,
    CommandSelectorSearchBar,
    useCommandSelectorNavigation,
    useFocusOnReady,
    useScrollActiveRowIntoView,
} from "@/app/view/cmdblock/command-selector-panel";
import { cn } from "@/util/util";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

export interface RewindSelectorProps {
    open: boolean;
    points: AgentRewindPointView[];
    loading: boolean;
    errorMessage?: string;
    onSelect: (turnId: string) => void;
    onClose: () => void;
}

function matchesRewindQuery(point: AgentRewindPointView, query: string): boolean {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return true;
    return [point.preview, point.turnId, point.reason, point.timestamp]
        .filter((value): value is string => !!value)
        .some((value) => value.toLocaleLowerCase().includes(normalized));
}

export function RewindSelector({ open, points, loading, errorMessage, onSelect, onClose }: RewindSelectorProps) {
    const optionIdPrefix = useId();
    const listboxId = `${optionIdPrefix}-rewind-options`;
    const [query, setQuery] = useState("");
    const panelRef = useRef<HTMLDivElement | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);
    const listboxRef = useRef<HTMLDivElement | null>(null);
    const filteredPoints = useMemo(() => points.filter((point) => matchesRewindQuery(point, query)), [points, query]);
    const eligiblePoints = useMemo(() => filteredPoints.filter((point) => point.eligible), [filteredPoints]);
    const ready = !loading && !errorMessage;
    const navigablePoints = useMemo(() => (ready ? eligiblePoints : []), [eligiblePoints, ready]);
    const eligibleKey = navigablePoints.map((point) => `${point.turnId}\u0000${point.preview}`).join("\u0001");
    const commitPoint = useCallback(
        (index: number) => {
            const point = navigablePoints[index];
            if (point) onSelect(point.turnId);
        },
        [navigablePoints, onSelect]
    );
    const { activeIdx, setActiveIdx, handleNavKey } = useCommandSelectorNavigation({
        itemCount: navigablePoints.length,
        onCommit: commitPoint,
        onDismiss: onClose,
    });

    useEffect(() => {
        if (!open) {
            setQuery("");
            return;
        }
        setActiveIdx(Math.max(0, navigablePoints.length - 1));
    }, [eligibleKey, navigablePoints.length, open, setActiveIdx]);

    useFocusOnReady(listboxRef, open);
    useScrollActiveRowIntoView(
        listboxRef,
        activeIdx,
        (index) => `[data-rewind-eligible-index="${index}"]`,
        open && ready && navigablePoints.length > 0
    );

    const handleKeyDown = useCallback(
        (event: React.KeyboardEvent) => {
            if (event.key === "Escape" && query) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
                return;
            }
            if (event.key === "/" && event.target !== searchRef.current) {
                event.preventDefault();
                searchRef.current?.focus();
                return;
            }
            handleNavKey(event);
        },
        [handleNavKey, query]
    );
    const handleSearchKeyDown = useCallback(
        (event: React.KeyboardEvent<HTMLInputElement>) => {
            handleKeyDown(event);
            event.stopPropagation();
        },
        [handleKeyDown]
    );

    if (!open) return null;

    let eligibleIndex = -1;
    const activePoint = navigablePoints[activeIdx];
    const activeOptionId = activePoint ? `${optionIdPrefix}-rewind-point-${activeIdx}` : undefined;

    return (
        <CommandInlineFrame commandName="/rewind" onDismiss={onClose} dismissOnEscape={false}>
            <CommandSelectorPanel panelRef={panelRef} ariaLabel="Rewind points" role="group">
                {errorMessage ? (
                    <CommandSelectorMessage tone="error">{errorMessage}</CommandSelectorMessage>
                ) : loading ? (
                    <CommandSelectorMessage>Loading rewind points…</CommandSelectorMessage>
                ) : points.length === 0 ? (
                    <CommandSelectorMessage>No rewind points available.</CommandSelectorMessage>
                ) : (
                    <>
                        <CommandSelectorSearchBar
                            inputRef={searchRef}
                            value={query}
                            onChange={setQuery}
                            onKeyDown={handleSearchKeyDown}
                            placeholder="Search rewind points…"
                            ariaLabel="Search rewind points"
                            ariaControls={listboxId}
                            ariaActiveDescendant={activeOptionId}
                            combobox
                            showShortcutHint={false}
                        />
                        {filteredPoints.length === 0 ? (
                            <CommandSelectorMessage>No matching rewind points.</CommandSelectorMessage>
                        ) : null}
                    </>
                )}
                <div
                    ref={listboxRef}
                    id={listboxId}
                    role="listbox"
                    aria-label="Rewind point options"
                    aria-activedescendant={activeOptionId}
                    tabIndex={-1}
                    onKeyDown={handleKeyDown}
                    className="max-h-[360px] overflow-y-auto px-1 pb-1 outline-none"
                >
                    {ready &&
                        filteredPoints.map((point) => {
                            const pointEligibleIndex = point.eligible ? ++eligibleIndex : undefined;
                            const active = pointEligibleIndex === activeIdx;
                            return (
                                <button
                                    key={point.turnId}
                                    id={
                                        pointEligibleIndex == null
                                            ? undefined
                                            : `${optionIdPrefix}-rewind-point-${pointEligibleIndex}`
                                    }
                                    type="button"
                                    role="option"
                                    aria-selected={active}
                                    aria-disabled={!point.eligible}
                                    disabled={!point.eligible}
                                    data-rewind-eligible-index={pointEligibleIndex}
                                    onMouseEnter={() => {
                                        if (pointEligibleIndex != null) setActiveIdx(pointEligibleIndex);
                                    }}
                                    onClick={() => {
                                        if (point.eligible) onSelect(point.turnId);
                                    }}
                                    className={cn(
                                        "flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left",
                                        point.eligible ? "cursor-pointer hover:bg-white/[0.06]" : "opacity-55",
                                        active && "bg-white/[0.10]"
                                    )}
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-foreground">{point.preview}</span>
                                        {point.reason && (
                                            <span className="mt-0.5 block text-secondary/70">{point.reason}</span>
                                        )}
                                    </span>
                                    {point.timestamp && (
                                        <time className="shrink-0 text-secondary/55">{point.timestamp}</time>
                                    )}
                                </button>
                            );
                        })}
                </div>
                {ready && points.length > 0 && (
                    <CommandSelectorHintFooter
                        hints={[
                            { keys: ["↑", "↓"], label: "navigate" },
                            { keys: ["Enter"], label: "preview" },
                            { keys: ["Esc"], label: "close" },
                        ]}
                        countText={`(${filteredPoints.length}/${points.length})`}
                    />
                )}
            </CommandSelectorPanel>
        </CommandInlineFrame>
    );
}
