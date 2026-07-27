// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ContextMenuModel } from "@/app/store/contextmenu";
import { TabCmdStateStore, getTabRunningKind, type AgentKind } from "@/app/store/tabcmdstate";
import * as WOS from "@/app/store/wos";
import { VTab, type VTabItem } from "@/app/tab/vtab";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { useAtomValue } from "jotai";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { TerminalTabListEnv } from "./terminal-tab-listenv";

export interface TerminalTabProjection {
    id: string;
    title?: string;
    runningKind?: AgentKind;
}

interface TerminalTabRowProps {
    terminalTabId: string;
    title?: string;
    runningKind?: AgentKind;
    active: boolean;
    tabIndex: number;
    query: string;
    draggable: boolean;
    isDragging: boolean;
    onSelect: () => void;
    onFocus: () => void;
    onNavigate: (direction: "previous" | "next" | "first" | "last") => void;
    onRename: (name: string) => void | Promise<void>;
    onClose: () => void;
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onMatchChange?: (terminalTabId: string, query: string, matches: boolean) => void;
    onDragStart: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
    onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
    onDragEnd: () => void;
    selectionRef: React.Ref<HTMLDivElement>;
}

export function TerminalTabRow({
    terminalTabId,
    title: projectedTitle,
    runningKind: projectedRunningKind,
    active,
    tabIndex,
    query,
    draggable,
    isDragging,
    onSelect,
    onFocus,
    onNavigate,
    onRename,
    onClose,
    onMoveUp,
    onMoveDown,
    onMatchChange,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    selectionRef,
}: TerminalTabRowProps) {
    const env = useWaveEnv<TerminalTabListEnv>();
    const [tab] = env.wos.useWaveObjectValue<Tab>(WOS.makeORef("tab", terminalTabId));
    const tabCmdStore = TabCmdStateStore.getInstance();
    const blockCmdState = useAtomValue(tabCmdStore.blockCmdStateAtom);
    const renameRef = useRef<(() => void) | null>(null);

    useEffect(() => {
        tabCmdStore.ensureSubscribed();
    }, [tabCmdStore]);

    const title = projectedTitle?.trim() || tab?.name?.trim() || "Terminal";
    const runningKind = projectedRunningKind ?? getTabRunningKind(tab?.blockids ?? [], blockCmdState);
    const matchesQuery = !query || title.toLocaleLowerCase().includes(query);
    useLayoutEffect(() => {
        if (!query) {
            return;
        }
        onMatchChange?.(terminalTabId, query, matchesQuery);
    }, [matchesQuery, onMatchChange, query, terminalTabId]);

    if (!matchesQuery) {
        return null;
    }

    const item: VTabItem = {
        id: terminalTabId,
        name: title,
        iconName: "terminal",
        runningKind,
    };
    const showContextMenu = (event: React.MouseEvent<HTMLDivElement | HTMLButtonElement>) => {
        const menu: ContextMenuItem[] = [
            { label: "Rename", click: () => renameRef.current?.() },
            { label: "Move Up", enabled: onMoveUp != null, click: onMoveUp },
            { label: "Move Down", enabled: onMoveDown != null, click: onMoveDown },
            { type: "separator" },
            { label: "Close", click: onClose },
        ];
        ContextMenuModel.getInstance().showContextMenu(menu, event);
    };
    const handleKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
        if (event.target !== event.currentTarget) {
            return;
        }
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
            return;
        }
        if (event.key === "F2") {
            event.preventDefault();
            renameRef.current?.();
            return;
        }
        if (event.key === "Delete") {
            event.preventDefault();
            onClose();
            return;
        }
        if (event.altKey) {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
                return;
            }
            event.preventDefault();
            if (event.key === "ArrowUp") {
                onMoveUp?.();
                return;
            }
            onMoveDown?.();
            return;
        }
        if (event.key === "ArrowUp") {
            event.preventDefault();
            onNavigate("previous");
            return;
        }
        if (event.key === "ArrowDown") {
            event.preventDefault();
            onNavigate("next");
            return;
        }
        if (event.key === "Home") {
            event.preventDefault();
            onNavigate("first");
            return;
        }
        if (event.key === "End") {
            event.preventDefault();
            onNavigate("last");
        }
    };

    return (
        <VTab
            tab={item}
            active={active}
            draggable={draggable}
            accessibleRow={{
                role: "option",
                label: title,
                tabIndex,
                selected: active,
                onKeyDown: handleKeyDown,
                onFocus,
                selectionRef,
            }}
            viewMode="compact"
            isDragging={isDragging}
            isReordering={isDragging}
            onSelect={onSelect}
            onClose={onClose}
            onRename={onRename}
            onContextMenu={showContextMenu}
            onMoreButtonClick={showContextMenu}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
            renameRef={renameRef}
        />
    );
}
