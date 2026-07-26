// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getFileIcon } from "@/app/fileexplorer/file-icon";
import { cn } from "@/util/util";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useSyncExternalStore,
    type KeyboardEvent,
    type PointerEvent,
    type Ref,
} from "react";
import type { TopTabRuntimeSnapshot, WorkspaceTopTabRuntimeRegistry } from "./top-tab-runtime-registry";
import type { TopTab } from "./workspace-content-state";

interface TopTabStripProps {
    tabs: TopTab[];
    activeTopTabId?: string;
    registry: WorkspaceTopTabRuntimeRegistry;
    onActivate(topTabId: string): void;
    onClose(topTabId: string): Promise<boolean>;
    onReorder(topTabId: string, targetIndex: number): void;
}

interface TopTabButtonProps {
    tab: TopTab;
    selected: boolean;
    tabStop: boolean;
    registry: WorkspaceTopTabRuntimeRegistry;
    tabRef: Ref<HTMLButtonElement>;
    onActivate(): void;
    onClose(): void;
    onPointerDown(event: PointerEvent<HTMLButtonElement>): void;
    onPointerUp(event: PointerEvent<HTMLButtonElement>): void;
    onPointerCancel(): void;
    onLostPointerCapture(): void;
    onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void;
}

function fileNameForTopTab(tab: TopTab): string {
    const source = tab.path || tab.title;
    const normalized = source.replace(/\\/g, "/");
    const segments = normalized.split("/").filter(Boolean);
    return segments.at(-1) || tab.title;
}

function TopTabButton({
    tab,
    selected,
    tabStop,
    registry,
    tabRef,
    onActivate,
    onClose,
    onPointerDown,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
    onKeyDown,
}: TopTabButtonProps) {
    const descriptorSnapshot = useMemo<TopTabRuntimeSnapshot>(
        () => ({ dirty: false, title: tab.title, status: "cold" }),
        [tab.title]
    );
    const subscribeMembership = useCallback(
        (listener: () => void) => registry.subscribe(tab.id, listener),
        [registry, tab.id]
    );
    const getMembership = useCallback(() => registry.get(tab.id), [registry, tab.id]);
    const runtime = useSyncExternalStore(subscribeMembership, getMembership, getMembership);
    const subscribeRuntime = useCallback(
        (listener: () => void) => (runtime ? runtime.subscribe(listener) : () => {}),
        [runtime]
    );
    const getRuntimeSnapshot = useCallback(
        () => (runtime ? runtime.getSnapshot() : descriptorSnapshot),
        [descriptorSnapshot, runtime]
    );
    const snapshot = useSyncExternalStore(subscribeRuntime, getRuntimeSnapshot, getRuntimeSnapshot);
    const label = snapshot.dirty ? `${snapshot.title}, unsaved changes` : snapshot.title;
    const FileIcon = getFileIcon(fileNameForTopTab(tab), false, false);

    return (
        <div
            className={cn(
                "group flex h-7 min-w-0 max-w-56 shrink-0 items-center rounded-md px-1 text-[13px] transition-colors",
                selected ? "bg-fg-overlay-2 text-primary" : "text-secondary hover:bg-fg-overlay-1 hover:text-primary"
            )}
            role="presentation"
        >
            <button
                aria-label={label}
                aria-selected={selected}
                className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-sm px-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                draggable={false}
                ref={tabRef}
                role="tab"
                tabIndex={tabStop ? 0 : -1}
                type="button"
                onClick={onActivate}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onActivate();
                        return;
                    }
                    onKeyDown(event);
                }}
                onLostPointerCapture={onLostPointerCapture}
                onPointerCancel={onPointerCancel}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
            >
                <FileIcon aria-hidden="true" className="size-3.5 shrink-0" size={14} />
                <span className="min-w-0 truncate">{snapshot.title}</span>
                {snapshot.dirty ? (
                    <span aria-hidden="true" className="shrink-0" data-testid={`top-tab-dirty-${tab.id}`}>
                        •
                    </span>
                ) : null}
            </button>
            <button
                aria-label={`Close ${snapshot.title}`}
                className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-secondary/70 hover:bg-fg-overlay-3 hover:text-primary focus-visible:bg-fg-overlay-3 focus-visible:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                type="button"
                onClick={onClose}
            >
                ×
            </button>
        </div>
    );
}

export function TopTabStrip({ tabs, activeTopTabId, registry, onActivate, onClose, onReorder }: TopTabStripProps) {
    const pointerSourceId = useRef("");
    const tabRefs = useRef(new Map<string, HTMLButtonElement>());
    const rovingId = tabs.some((tab) => tab.id === activeTopTabId) ? activeTopTabId : tabs[0]?.id;

    useEffect(() => {
        const clearPointerSource = () => {
            pointerSourceId.current = "";
        };
        window.addEventListener("pointerup", clearPointerSource);
        return () => window.removeEventListener("pointerup", clearPointerSource);
    }, []);

    const moveFocus = (targetIndex: number) => {
        const target = tabs[targetIndex];
        if (!target) {
            return;
        }
        onActivate(target.id);
        tabRefs.current.get(target.id)?.focus();
    };

    return (
        <div
            aria-label="Open files"
            className="flex min-w-0 max-w-[50vw] shrink items-center gap-1 overflow-x-auto"
            role="tablist"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
            {tabs.map((tab, index) => (
                <TopTabButton
                    key={tab.id}
                    tab={tab}
                    selected={tab.id === activeTopTabId}
                    tabStop={tab.id === rovingId}
                    registry={registry}
                    tabRef={(element) => {
                        if (element) {
                            tabRefs.current.set(tab.id, element);
                        } else {
                            tabRefs.current.delete(tab.id);
                        }
                    }}
                    onActivate={() => onActivate(tab.id)}
                    onClose={() => {
                        void onClose(tab.id).catch(() => {});
                    }}
                    onPointerDown={() => {
                        pointerSourceId.current = tab.id;
                    }}
                    onPointerUp={() => {
                        const sourceId = pointerSourceId.current;
                        pointerSourceId.current = "";
                        if (sourceId && sourceId !== tab.id) {
                            onReorder(sourceId, index);
                        }
                    }}
                    onPointerCancel={() => {
                        pointerSourceId.current = "";
                    }}
                    onLostPointerCapture={() => {
                        pointerSourceId.current = "";
                    }}
                    onKeyDown={(event) => {
                        let targetIndex = -1;
                        if (event.key === "ArrowRight") {
                            targetIndex = (index + 1) % tabs.length;
                        } else if (event.key === "ArrowLeft") {
                            targetIndex = (index - 1 + tabs.length) % tabs.length;
                        } else if (event.key === "Home") {
                            targetIndex = 0;
                        } else if (event.key === "End") {
                            targetIndex = tabs.length - 1;
                        }
                        if (targetIndex < 0) {
                            return;
                        }
                        event.preventDefault();
                        moveFocus(targetIndex);
                    }}
                />
            ))}
        </div>
    );
}
