// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// BlockOverlay — command-block chrome (divider / header bar / sticky header /
// per-block search) rendered over the xterm canvas. Ported from terax-ai
// BlockOverlay.tsx with the positioning math and interaction logic unchanged.
// Adaptations: hugeicons → UIcon, shadcn DropdownMenu → floating-ui popover
// (crest's popover primitive), Tauri homeDir → getApi().getHomeDir(), and the
// chat-store attach action → an optional onAskAI prop wired by the host.

import { UIcon } from "@/app/element/ui-icon";
import { getApi } from "@/store/global";
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
import { useEffect, useRef, useState } from "react";
import type { BlockMatch, PositionedBlock, VisibleBlocks } from "./block-decorations";
import { capAttachOutput } from "./output-cap";

const Empty: VisibleBlocks = { blocks: [], sticky: null };

const ChipCls =
    "pointer-events-auto flex items-center gap-px rounded-[7px] border border-border bg-popover/95 text-muted-foreground shadow-[0_4px_14px_rgba(0,0,0,0.28)]";
const BtnCls =
    "flex h-[18px] w-[22px] cursor-pointer items-center justify-center rounded-[5px] transition-colors hover:bg-fg-overlay-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
const MenuItemCls =
    "flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left text-xs text-foreground hover:bg-fg-overlay-2 disabled:pointer-events-none disabled:opacity-40";

type Props = {
    subscribe: (cb: () => void) => () => void;
    getVisible: () => VisibleBlocks;
    readOutput: (id: string) => string | null;
    searchBlock: (id: string, query: string) => BlockMatch[];
    revealMatch: (m: BlockMatch) => void;
    clearSearch: () => void;
    promptReady: boolean;
    onRunAgain: (command: string) => void;
    onRestoreFocus: () => void;
    onAskAI?: (blockId: string, output: string) => void;
};

function fmtDuration(ms: number): string | null {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
    if (ms < 3_600_000) {
        const m = Math.floor(ms / 60000);
        const s = Math.round((ms % 60000) / 1000);
        return s ? `${m}m ${s}s` : `${m}m`;
    }
    const h = Math.floor(ms / 3_600_000);
    const m = Math.round((ms % 3_600_000) / 60000);
    return m ? `${h}h ${m}m` : `${h}h`;
}

function fmtTime(ms: number): string {
    const d = new Date(ms);
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
}

let cachedHome: string | null = null;

function homePrefix(): string {
    if (cachedHome == null) {
        // Preview/test hosts may not expose the electron API; fall back to
        // absolute paths rather than crashing the overlay.
        try {
            cachedHome = (getApi().getHomeDir() ?? "").replace(/\/+$/, "");
        } catch {
            cachedHome = "";
        }
    }
    return cachedHome;
}

function relPath(p: string): string {
    const home = homePrefix();
    if (home && (p === home || p.startsWith(`${home}/`))) {
        return `~${p.slice(home.length)}`;
    }
    return p;
}

// crest has no generic toast surface (ToastModel is agent-notification
// specific), so success is silent — same convention as BlockContextMenu.
function copyText(text: string) {
    void navigator.clipboard.writeText(text).catch((e) => console.warn("clipboard write failed:", e));
}

function signature(v: VisibleBlocks): string {
    let s = v.sticky?.id ?? "";
    for (const b of v.blocks) {
        s += `|${b.id}:${Math.round(b.top)}:${Math.round(b.bottom)}:${b.running}`;
    }
    return s;
}

export function BlockOverlay(props: Props) {
    const { subscribe, getVisible } = props;
    const [vis, setVis] = useState<VisibleBlocks>(Empty);
    const [searchId, setSearchId] = useState<string | null>(null);
    const lastSig = useRef("");

    useEffect(() => {
        const update = () => {
            const v = getVisible();
            const sig = signature(v);
            if (sig === lastSig.current) return;
            lastSig.current = sig;
            setVis(v);
        };
        update();
        return subscribe(update);
    }, [subscribe, getVisible]);

    const closeSearch = () => {
        props.clearSearch();
        setSearchId(null);
    };

    return (
        <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
            {vis.blocks.map((b) => (
                <BlockChrome key={b.id} block={b} all={props} onSearch={setSearchId} />
            ))}
            {vis.sticky && <StickyHeader block={vis.sticky} all={props} onSearch={setSearchId} />}
            {searchId && (
                <SearchBar
                    blockId={searchId}
                    searchBlock={props.searchBlock}
                    revealMatch={props.revealMatch}
                    onClose={closeSearch}
                />
            )}
        </div>
    );
}

type ChromeProps = {
    block: PositionedBlock;
    all: Props;
    onSearch: (id: string) => void;
};

// No chrome while the command runs; the bar lands together with the divider
// once the block is finished.
function BlockChrome({ block, all, onSearch }: ChromeProps) {
    if (block.running) return null;
    return (
        <>
            <div
                className={cn(
                    "pointer-events-none absolute inset-x-0 h-px bg-foreground/8",
                    !block.ok && "bg-destructive/50"
                )}
                style={{ top: block.bottom }}
            />
            <div
                className="absolute inset-x-2 flex h-[18px] items-center justify-between opacity-70 transition-opacity hover:opacity-100"
                style={{ top: block.headerTop }}
            >
                <Meta block={block} />
                <Toolbar block={block} all={all} onSearch={onSearch} />
            </div>
        </>
    );
}

function Meta({ block }: { block: PositionedBlock }) {
    return (
        <span className="flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
            {block.cwd && (
                <span className="max-w-64 overflow-hidden font-mono text-ellipsis whitespace-nowrap">
                    {relPath(block.cwd)}
                </span>
            )}
            <span className="inline-flex items-center gap-[3px] opacity-85 tabular-nums">
                <UIcon name="clock" size={11} />
                {fmtTime(block.startedAt)}
            </span>
        </span>
    );
}

function StickyHeader({ block, all, onSearch }: ChromeProps) {
    return (
        <div className="absolute inset-x-0 top-0 flex items-center gap-[7px] border-b border-border/60 bg-popover/95 py-[3px] pr-1.5 pl-2.5">
            <UIcon name="terminal" size={12} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 overflow-hidden font-mono text-[11px] text-ellipsis whitespace-nowrap text-foreground/90">
                {block.command || "command"}
            </span>
            <Toolbar block={block} all={all} onSearch={onSearch} />
        </div>
    );
}

function Toolbar({ block, all, onSearch }: ChromeProps) {
    const duration = block.running ? null : fmtDuration(block.finishedAt - block.startedAt);
    const failed = !block.running && !block.ok && block.exitCode != null;
    return (
        <div className={cn(ChipCls, "px-[3px] py-px")}>
            {failed && (
                <span className="rounded px-[5px] text-[10px] text-destructive tabular-nums">
                    exit {block.exitCode}
                </span>
            )}
            {duration && <span className="px-[5px] text-[10px] opacity-85 tabular-nums">{duration}</span>}
            {!block.running && !!block.command && (
                <button
                    type="button"
                    title="Run again"
                    className={BtnCls}
                    disabled={!all.promptReady}
                    onClick={() => all.onRunAgain(block.command)}
                >
                    <UIcon name="refresh-ccw-01" size={12.5} />
                </button>
            )}
            <BlockMenu block={block} all={all} onSearch={onSearch} />
        </div>
    );
}

function BlockMenu({ block, all, onSearch }: ChromeProps) {
    const [open, setOpen] = useState(false);
    const { refs, floatingStyles, context } = useFloating({
        open,
        onOpenChange: (next) => {
            setOpen(next);
            // Mirrors terax's onCloseAutoFocus: hand focus back to the
            // terminal instead of letting it land on the trigger button.
            if (!next) all.onRestoreFocus();
        },
        placement: "bottom-end",
        middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });
    const dismiss = useDismiss(context, { outsidePress: true, escapeKey: true });
    const role = useRole(context, { role: "menu" });
    const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role]);

    const output = () => all.readOutput(block.id) ?? "";
    const pick = (action: () => void) => {
        action();
        setOpen(false);
        all.onRestoreFocus();
    };
    const attach = () => {
        const out = capAttachOutput(output());
        const text = out ? `$ ${block.command}\n${out}` : `$ ${block.command}`;
        all.onAskAI(block.id, text);
    };

    return (
        <>
            <button
                ref={refs.setReference}
                type="button"
                title="Block actions"
                className={BtnCls}
                {...getReferenceProps({ onClick: () => setOpen((v) => !v) })}
            >
                <UIcon name="dots-horizontal" size={14} />
            </button>
            {open && (
                <FloatingPortal>
                    <div
                        ref={refs.setFloating}
                        style={floatingStyles}
                        {...getFloatingProps()}
                        className="z-[1000] min-w-44 rounded-md border border-fg-overlay-3 bg-popover py-1 shadow-xl"
                    >
                        <MenuItem
                            icon="refresh-ccw-01"
                            label="Run again"
                            disabled={block.running || !all.promptReady || !block.command}
                            onClick={() => pick(() => all.onRunAgain(block.command))}
                        />
                        <MenuItem
                            icon="copy"
                            label="Copy command"
                            disabled={!block.command}
                            onClick={() => pick(() => copyText(block.command))}
                        />
                        <MenuItem
                            icon="terminal-input"
                            label="Copy output"
                            onClick={() =>
                                pick(() => {
                                    const o = output();
                                    if (o) copyText(o);
                                })
                            }
                        />
                        <MenuItem
                            icon="copy"
                            label="Copy command and output"
                            onClick={() => pick(() => copyText(`$ ${block.command}\n${output()}`))}
                        />
                        {all.onAskAI && (
                            <MenuItem icon="sparkle" label="Attach to AI chat" onClick={() => pick(attach)} />
                        )}
                        <MenuItem icon="search" label="Find in block" onClick={() => pick(() => onSearch(block.id))} />
                    </div>
                </FloatingPortal>
            )}
        </>
    );
}

function MenuItem({
    icon,
    label,
    disabled,
    onClick,
}: {
    icon: string;
    label: string;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button type="button" disabled={disabled} onClick={onClick} className={MenuItemCls}>
            <UIcon name={icon} size={13} />
            {label}
        </button>
    );
}

// One fixed search bar pinned to the top of the terminal so it stays put while
// navigating matches (the grid scrolls underneath).
function SearchBar({
    blockId,
    searchBlock,
    revealMatch,
    onClose,
}: {
    blockId: string;
    searchBlock: (id: string, query: string) => BlockMatch[];
    revealMatch: (m: BlockMatch) => void;
    onClose: () => void;
}) {
    const [matches, setMatches] = useState<BlockMatch[]>([]);
    const [idx, setIdx] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    const run = (query: string) => {
        const m = searchBlock(blockId, query);
        setMatches(m);
        setIdx(0);
        if (m.length) revealMatch(m[0]);
    };
    const nav = (dir: number) => {
        if (!matches.length) return;
        const next = (idx + dir + matches.length) % matches.length;
        setIdx(next);
        revealMatch(matches[next]);
    };

    return (
        <div className={cn(ChipCls, "absolute top-2 right-2 px-1 py-0.5 shadow-[0_8px_24px_rgba(0,0,0,0.35)]")}>
            <UIcon name="search" size={12} />
            <input
                ref={inputRef}
                className="w-36 border-none bg-transparent px-1 text-[11px] text-foreground outline-none placeholder:text-muted-foreground/60"
                placeholder="Find in block"
                onChange={(e) => run(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        nav(e.shiftKey ? -1 : 1);
                    } else if (e.key === "Escape") {
                        e.preventDefault();
                        onClose();
                    }
                }}
            />
            <span className="px-1 text-[10px] opacity-70 tabular-nums">
                {matches.length ? `${idx + 1}/${matches.length}` : "0"}
            </span>
            <SearchBtn title="Previous" icon="chevron-up" onClick={() => nav(-1)} />
            <SearchBtn title="Next" icon="chevron-down" onClick={() => nav(1)} />
            <SearchBtn title="Close" icon="x-close" onClick={onClose} />
        </div>
    );
}

function SearchBtn({ title, icon, onClick }: { title: string; icon: string; onClick: () => void }) {
    return (
        <button type="button" title={title} onClick={onClick} className={BtnCls}>
            <UIcon name={icon} size={13} />
        </button>
    );
}
