// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getCachedHome, workspaceDirAtom } from "@/app/fileexplorer/file-explorer-atoms";
import { atoms, createBlock, createTab, globalStore, replaceBlock } from "@/app/store/global";
import { modalsModel } from "@/app/store/modalmodel";
import {
    genericClose,
    handleCmdN,
    handleSplitHorizontal,
    handleSplitVertical,
    simpleCloseStaticTab,
    switchBlockInDirection,
    switchTab,
} from "@/app/store/keymodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { ThemeModel } from "@/app/theme/theme-model";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { getLayoutModelForStaticTab, NavigateDirection } from "@/layout/index";
import { cn, fireAndForget } from "@/util/util";
import { Icon } from "@/app/icon/Icon";
import { useAtomValue } from "jotai";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import "./commandpalette.scss";

// ---- types ----

interface PaletteCommand {
    id: string;
    label: string;
    category: string;
    shortcut?: string[];
    icon: string;
    action: () => void;
}

// ---- theme switcher ----
//
// Each bundled theme becomes its own searchable palette entry under the
// "Theme" category.  The label always includes the word "Theme" so a
// generic search for "theme" surfaces all of them; typing the theme's
// display name (e.g. "gruvbox", "cyber wave", "solarized") also matches
// via the substring filter further down.  Selecting an entry persists
// term:theme via SetConfigCommand AND calls ThemeModel.applyTheme()
// directly for instant feedback — without the second call the user
// would see a one-frame delay while the new fullConfig propagates back
// from the server via the file watcher.
//
// Arrow-key navigation also previews the theme live (see useEffect on
// selectedIdx further down): the visible UI tracks the highlighted
// entry, and closing the palette without pressing Enter reverts to the
// theme that was active when the palette opened.

const THEME_CMD_PREFIX = "theme-switch-";

function isThemeCmd(cmd: PaletteCommand): boolean {
    return cmd.id.startsWith(THEME_CMD_PREFIX);
}

function themeKeyFromCmd(cmd: PaletteCommand): string {
    return cmd.id.slice(THEME_CMD_PREFIX.length);
}

function buildThemeCommands(): PaletteCommand[] {
    const fullConfig = globalStore.get(atoms.fullConfigAtom);
    const themes = fullConfig?.termthemes ?? {};
    const activeKey = fullConfig?.settings?.["term:theme"];

    const entries = Object.entries(themes)
        .map(([key, theme]) => ({
            key,
            name: theme["display:name"] || key,
            order: theme["display:order"] ?? Number.MAX_SAFE_INTEGER,
            theme,
        }))
        .sort((a, b) => (a.order !== b.order ? a.order - b.order : a.name.localeCompare(b.name)));

    return entries.map((entry) => ({
        id: `${THEME_CMD_PREFIX}${entry.key}`,
        label: `Theme: ${entry.name}${entry.key === activeKey ? "  (active)" : ""}`,
        category: "Theme",
        icon: "color-picker",
        action: () => {
            ThemeModel.getInstance().applyTheme(entry.key, entry.theme);
            fireAndForget(() => RpcApi.SetConfigCommand(TabRpcClient, { "term:theme": entry.key }));
        },
    }));
}

// Apply a theme to the live UI without persisting it.  Used by the
// preview-on-arrow flow; the committing path (Enter / click) goes
// through the command's action which both applies AND persists.
function applyThemePreview(key: string): boolean {
    const themes = globalStore.get(atoms.fullConfigAtom)?.termthemes ?? {};
    const theme = themes[key];
    if (!theme) return false;
    ThemeModel.getInstance().applyTheme(key, theme);
    return true;
}

// ---- static command list ----

function buildCommandList(): PaletteCommand[] {
    return [
        {
            id: "new-terminal",
            label: "New Terminal",
            category: "Create",
            shortcut: ["⌘", "N"],
            icon: "terminal",
            action: () => fireAndForget(handleCmdN),
        },
        {
            id: "split-horizontal",
            label: "Split Horizontal",
            category: "Create",
            shortcut: ["⌘", "D"],
            icon: "table-columns-split",
            action: () => fireAndForget(() => handleSplitHorizontal("after")),
        },
        {
            id: "split-vertical",
            label: "Split Vertical",
            category: "Create",
            shortcut: ["⇧", "⌘", "D"],
            icon: "table-rows-split",
            action: () => fireAndForget(() => handleSplitVertical("after")),
        },
        {
            id: "new-tab",
            label: "New Tab",
            category: "Create",
            shortcut: ["⌘", "T"],
            icon: "plus-sign",
            action: () => fireAndForget(createTab),
        },
        {
            id: "open-launcher",
            label: "Open Launcher",
            category: "Create",
            shortcut: ["⌃", "⇧", "X"],
            icon: "grid-2-x2",
            action: () => {
                const layoutModel = getLayoutModelForStaticTab();
                const node = globalStore.get(layoutModel.focusedNode);
                if (node != null) {
                    fireAndForget(() => replaceBlock(node.data.blockId, { meta: { view: "launcher" } }, true));
                }
            },
        },
        {
            id: "focus-up",
            label: "Focus Block Above",
            category: "Navigate",
            shortcut: ["⌃", "⇧", "↑"],
            icon: "arrow-up",
            action: () => switchBlockInDirection(NavigateDirection.Up),
        },
        {
            id: "focus-down",
            label: "Focus Block Below",
            category: "Navigate",
            shortcut: ["⌃", "⇧", "↓"],
            icon: "arrow-down-01",
            action: () => switchBlockInDirection(NavigateDirection.Down),
        },
        {
            id: "focus-left",
            label: "Focus Block Left",
            category: "Navigate",
            shortcut: ["⌃", "⇧", "←"],
            icon: "arrow-left-01",
            action: () => switchBlockInDirection(NavigateDirection.Left),
        },
        {
            id: "focus-right",
            label: "Focus Block Right",
            category: "Navigate",
            shortcut: ["⌃", "⇧", "→"],
            icon: "arrow-right-01",
            action: () => switchBlockInDirection(NavigateDirection.Right),
        },
        {
            id: "next-tab",
            label: "Next Tab",
            category: "Navigate",
            shortcut: ["⌘", "]"],
            icon: "chevron-right",
            action: () => switchTab(1),
        },
        {
            id: "prev-tab",
            label: "Previous Tab",
            category: "Navigate",
            shortcut: ["⌘", "["],
            icon: "chevron-left",
            action: () => switchTab(-1),
        },
        {
            id: "toggle-file-explorer",
            label: "Toggle File Explorer",
            category: "View",
            shortcut: ["⌘", "B"],
            icon: "sidebar-left",
            action: () => {
                const model = WorkspaceLayoutModel.getInstance();
                model.setVTabVisible(!model.getVTabVisible());
            },
        },
        {
            id: "magnify-block",
            label: "Magnify Current Block",
            category: "View",
            shortcut: ["⌘", "M"],
            icon: "search-add",
            action: () => {
                const layoutModel = getLayoutModelForStaticTab();
                const node = globalStore.get(layoutModel.focusedNode);
                if (node != null) {
                    layoutModel.magnifyNodeToggle(node.id);
                }
            },
        },
        {
            id: "open-settings",
            label: "Open Settings",
            category: "View",
            icon: "settings-01",
            action: () => fireAndForget(() => createBlock({ meta: { view: "waveconfig" } })),
        },
        {
            id: "close-block",
            label: "Close Block",
            category: "Actions",
            shortcut: ["⌘", "W"],
            icon: "cancel-01",
            action: genericClose,
        },
        {
            id: "close-tab",
            label: "Close Tab",
            category: "Actions",
            shortcut: ["⇧", "⌘", "W"],
            icon: "cancel-circle",
            action: simpleCloseStaticTab,
        },
        {
            id: "about",
            label: "About",
            category: "Actions",
            icon: "information-circle",
            action: () => modalsModel.pushModal("AboutModal"),
        },
    ];
}

function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
    if (!query.trim()) {
        return commands;
    }
    const lq = query.toLowerCase();
    return commands.filter((cmd) => cmd.label.toLowerCase().includes(lq) || cmd.category.toLowerCase().includes(lq));
}

function groupByCategory(commands: PaletteCommand[]): { category: string; items: PaletteCommand[] }[] {
    const groups = new Map<string, PaletteCommand[]>();
    for (const cmd of commands) {
        if (!groups.has(cmd.category)) {
            groups.set(cmd.category, []);
        }
        groups.get(cmd.category).push(cmd);
    }
    return Array.from(groups.entries()).map(([category, items]) => ({ category, items }));
}

// ---- match highlight ----

function MatchHighlight({ text, matchpos }: { text: string; matchpos?: number[] }) {
    if (!matchpos?.length) {
        return <>{text}</>;
    }
    const posSet = new Set(matchpos);
    return (
        <>
            {Array.from(text).map((ch, i) =>
                posSet.has(i) ? (
                    <span key={i} className="palette-match-char">
                        {ch}
                    </span>
                ) : (
                    <React.Fragment key={i}>{ch}</React.Fragment>
                )
            )}
        </>
    );
}

// ---- file icon helper ----

function fileIconName(suggestion: SuggestionType): string {
    if (suggestion.icon) {
        return suggestion.icon;
    }
    const mime = suggestion["file:mimetype"] ?? "";
    if (mime === "directory") return "folder-01";
    return "file";
}

// ---- main component ----

const CommandPaletteModal = () => {
    const [query, setQuery] = useState("");
    const [selectedIdx, setSelectedIdx] = useState(0);
    const [fileResults, setFileResults] = useState<SuggestionType[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const reqNumRef = useRef(0);

    // Live theme-preview bookkeeping:
    //   original   — the persisted theme when the modal opened; we revert
    //                here if the user closes without committing.
    //   previewing — the theme currently shown via preview (null = no
    //                preview active, the original is on screen).
    //   committed  — set true by executeCommand when a theme entry is
    //                chosen so the unmount cleanup doesn't undo the save.
    const previewRef = useRef<{ original: string | null; previewing: string | null; committed: boolean }>({
        original: null,
        previewing: null,
        committed: false,
    });

    // Re-evaluate when fullConfig changes so the active-theme marker stays
    // in sync and any user-added termthemes show up without a reload.
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const allCommands = useMemo(() => [...buildCommandList(), ...buildThemeCommands()], [fullConfig]);
    const cwd = useAtomValue(workspaceDirAtom);

    const isCommandMode = query.startsWith(">");
    const cmdQuery = isCommandMode ? query.slice(1).trimStart() : "";
    const fileQuery = isCommandMode ? "" : query;

    const filteredCommands = useMemo(
        () => (isCommandMode ? filterCommands(allCommands, cmdQuery) : []),
        [allCommands, cmdQuery, isCommandMode]
    );

    const totalResults = isCommandMode ? filteredCommands.length : fileResults.length;

    // auto-focus input + snapshot the active theme for revert-on-cancel
    useEffect(() => {
        inputRef.current?.focus();
        previewRef.current.original = globalStore.get(atoms.fullConfigAtom)?.settings?.["term:theme"] ?? null;
        return () => {
            // Cleanup: if a theme was previewed but never committed,
            // restore the original so the visible UI matches what's
            // actually persisted in settings.
            const { original, previewing, committed } = previewRef.current;
            if (!committed && previewing != null && previewing !== original) {
                if (original) {
                    applyThemePreview(original);
                }
            }
        };
    }, []);

    // Preview the highlighted theme as the user arrows up/down.  When
    // the highlight moves off a theme entry (onto a normal command or
    // out of command mode entirely), we revert to the original so the
    // visible theme always matches what pressing Enter at that moment
    // would persist.
    useEffect(() => {
        const cmd = isCommandMode ? filteredCommands[selectedIdx] : null;
        if (cmd != null && isThemeCmd(cmd)) {
            const key = themeKeyFromCmd(cmd);
            if (applyThemePreview(key)) {
                previewRef.current.previewing = key;
            }
            return;
        }
        if (previewRef.current.previewing != null && previewRef.current.original != null) {
            applyThemePreview(previewRef.current.original);
            previewRef.current.previewing = null;
        }
    }, [selectedIdx, filteredCommands, isCommandMode]);

    // file search with debounce
    useEffect(() => {
        if (isCommandMode || !fileQuery) {
            setFileResults([]);
            setIsSearching(false);
            return;
        }
        const rn = ++reqNumRef.current;
        setIsSearching(true);
        let cancelled = false;
        const timer = setTimeout(async () => {
            try {
                const result = await RpcApi.FetchSuggestionsCommand(TabRpcClient, {
                    suggestiontype: "file",
                    query: fileQuery,
                    widgetid: "command-palette-files",
                    reqnum: rn,
                    "file:cwd": cwd ?? getCachedHome(),
                });
                if (cancelled || rn !== reqNumRef.current) return;
                setFileResults(result?.suggestions ?? []);
                setSelectedIdx(0);
            } catch {
                if (!cancelled && rn === reqNumRef.current) setFileResults([]);
            } finally {
                if (!cancelled && rn === reqNumRef.current) setIsSearching(false);
            }
        }, 80);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [fileQuery, cwd, isCommandMode]);

    // reset selected on mode switch
    useEffect(() => {
        setSelectedIdx(0);
    }, [isCommandMode]);

    // scroll selected into view
    useEffect(() => {
        if (listRef.current == null) return;
        const selected = listRef.current.querySelector<HTMLElement>(".palette-item-selected");
        selected?.scrollIntoView({ block: "nearest" });
    }, [selectedIdx]);

    const close = useCallback(() => modalsModel.popModal(), []);

    const executeCommand = useCallback((cmd: PaletteCommand) => {
        // Theme commands set committed=true so the unmount-cleanup
        // doesn't undo the apply+persist they're about to perform.
        // Must run before popModal — popModal triggers the cleanup
        // synchronously, before cmd.action() gets a chance to run.
        if (isThemeCmd(cmd)) {
            previewRef.current.committed = true;
        }
        // pop first so the modal cleanup runs synchronously before the action
        // (avoids focus-trap conflicts when an action opens another modal)
        modalsModel.popModal();
        cmd.action();
    }, []);

    const openFile = useCallback((suggestion: SuggestionType) => {
        const filePath = suggestion["file:path"];
        if (!filePath) return;
        modalsModel.popModal();
        fireAndForget(() => createBlock({ meta: { view: "preview", file: filePath } }));
    }, []);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                close();
                return;
            }
            if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelectedIdx((prev) => (prev + 1) % Math.max(totalResults, 1));
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelectedIdx((prev) => (prev - 1 + Math.max(totalResults, 1)) % Math.max(totalResults, 1));
                return;
            }
            if (e.key === "Enter") {
                e.preventDefault();
                if (isCommandMode) {
                    if (filteredCommands[selectedIdx] != null) {
                        executeCommand(filteredCommands[selectedIdx]);
                    }
                } else {
                    if (fileResults[selectedIdx] != null) {
                        openFile(fileResults[selectedIdx]);
                    }
                }
                return;
            }
        },
        [totalResults, isCommandMode, filteredCommands, fileResults, selectedIdx, close, executeCommand, openFile]
    );

    const groups = useMemo(() => groupByCategory(filteredCommands), [filteredCommands]);
    let globalIdx = -1;

    const placeholder = isCommandMode ? "Search commands..." : "Search files...";

    return ReactDOM.createPortal(
        <div className="command-palette-wrapper" onMouseDown={close}>
            <div className="command-palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
                {/* input row */}
                <div className="command-palette-input-row">
                    {isCommandMode ? (
                        <span className="command-palette-mode-icon">{">"}</span>
                    ) : (
                        <Icon name="magnifying-glass" size={14} className="command-palette-search-icon" />
                    )}
                    <input
                        ref={inputRef}
                        type="text"
                        className="command-palette-input"
                        placeholder={placeholder}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    {isSearching && <Icon name="spinner" size={14} className="command-palette-spinner" spin />}
                    {query && !isSearching && (
                        <button className="command-palette-clear-btn cursor-pointer" onClick={() => setQuery("")}>
                            <Icon name="xmark" size={14} />
                        </button>
                    )}
                </div>

                {/* file results */}
                {!isCommandMode && fileQuery && (
                    <div ref={listRef} className="command-palette-list">
                        {fileResults.map((s, idx) => (
                            <div
                                key={s.suggestionid}
                                className={cn("command-palette-item cursor-pointer", {
                                    "palette-item-selected": idx === selectedIdx,
                                })}
                                onMouseEnter={() => setSelectedIdx(idx)}
                                onClick={() => openFile(s)}
                            >
                                <Icon name={fileIconName(s)} size={14} className="command-palette-item-icon" />
                                <span className="command-palette-item-label">
                                    <MatchHighlight text={s.display} matchpos={s.matchpos} />
                                </span>
                                {s.subtext && (
                                    <span className="command-palette-file-subtext">{s.subtext}</span>
                                )}
                            </div>
                        ))}
                        {!isSearching && fileResults.length === 0 && (
                            <div className="command-palette-empty">No files found for &ldquo;{fileQuery}&rdquo;</div>
                        )}
                    </div>
                )}

                {/* command results */}
                {isCommandMode && (
                    <div ref={listRef} className="command-palette-list">
                        {groups.map(({ category, items }) => (
                            <div key={category}>
                                <div className="command-palette-category">{category}</div>
                                {items.map((cmd) => {
                                    globalIdx += 1;
                                    const idx = globalIdx;
                                    return (
                                        <div
                                            key={cmd.id}
                                            className={cn("command-palette-item cursor-pointer", {
                                                "palette-item-selected": idx === selectedIdx,
                                            })}
                                            onMouseEnter={() => setSelectedIdx(idx)}
                                            onClick={() => executeCommand(cmd)}
                                        >
                                            <i className={cn(cmd.icon, "command-palette-item-icon")} />
                                            <span className="command-palette-item-label">{cmd.label}</span>
                                            {cmd.shortcut != null && (
                                                <div className="command-palette-shortcut">
                                                    {cmd.shortcut.map((key, i) => (
                                                        <kbd key={i} className="command-palette-key">
                                                            {key}
                                                        </kbd>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                        {filteredCommands.length === 0 && cmdQuery && (
                            <div className="command-palette-empty">No commands found for &ldquo;{cmdQuery}&rdquo;</div>
                        )}
                    </div>
                )}

                {/* footer hint */}
                <div className="command-palette-footer">
                    {isCommandMode ? (
                        <span>Delete &lsquo;&gt;&rsquo; to search files</span>
                    ) : (
                        <span>
                            Type <kbd className="command-palette-key">&gt;</kbd> for commands
                        </span>
                    )}
                    <span className="command-palette-footer-nav">
                        <kbd className="command-palette-key">↑</kbd>
                        <kbd className="command-palette-key">↓</kbd> navigate &nbsp;
                        <kbd className="command-palette-key">↵</kbd> open
                    </span>
                </div>
            </div>
        </div>,
        document.getElementById("main") ?? document.body
    );
};

CommandPaletteModal.displayName = "CommandPaletteModal";

export { CommandPaletteModal };
