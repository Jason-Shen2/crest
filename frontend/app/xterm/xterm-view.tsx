// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// XtermView — React host for the pooled xterm engine. Replaces the old
// TerminalView (frontend/app/term/render/terminal-view.tsx): props stay
// superset-compatible so the view-model adapters swap render targets without
// changing shape. The component owns only DOM concerns — a host div that
// xterm-session binds a renderer-pool slot into, visibility/focus signals,
// and the notification toast. Parsing, scrollback, resize (fit addon), and
// key encoding all live in xterm-session.ts / renderer-pool.ts.
// With `blocks` set, the view additionally mounts the command-block chrome
// (BlockOverlay/BlockWatermark) over the host and docks CmdBlockInput below
// it, shown at the prompt and hidden while a command runs or a TUI owns the
// screen (docs/terax-terminal-port.md §四 P3.2/P3.3).

import { globalStore } from "@/app/store/jotaiStore";
import { TerminalNotification } from "@/app/term/render/terminal-notification";
import { CmdBlockInput } from "@/app/view/cmdblock/cmdblock-input";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BlockMatch } from "./block/block-decorations";
import { BlockOverlay } from "./block/block-overlay";
import { BlockWatermark } from "./block/block-watermark";
import { getXtermPaneModel } from "./xterm-pane-model";
import {
    attachSession,
    clearSessionBlockSearch,
    detachSession,
    focusSession,
    focusSessionInput,
    getSessionBlockMode,
    getSessionVisibleBlocks,
    getSessionWatermarkState,
    interruptSession,
    readSessionBlockOutput,
    revealSessionBlockMatch,
    searchSessionBlock,
    selectSessionBlockAt,
    setSessionInputActivity,
    setSessionInputFocus,
    setSessionVisibility,
    submitToSession,
    subscribeSessionBlockMode,
    subscribeSessionBlocks,
    writeToSession,
    type SessionCallbacks,
} from "./xterm-session";

const NotificationAutoDismissMs = 3500;

export interface XtermViewProps {
    outerBlockId: string;
    // Accepted for adapter compatibility with the old TerminalView; the
    // renderer pool applies the term:fontsize setting globally to all slots
    // (applyFontSize), so a per-pane override has no effect yet.
    fontSize?: number;
    focusRequest?: number;
    // Content that mounts *above* the terminal host — used by the "term"
    // view type to surface a VDom subblock as a toolbar strip.
    topSlot?: React.ReactNode;
    // When set, the terminal is replaced entirely by this content
    // (term:mode = "vdom"); no session is attached while it is shown.
    replaceContent?: React.ReactNode;
    // Enable command-block UX: OSC 133 decorations overlay + editor input bar.
    blocks?: boolean;
    // Overlay "Attach to AI chat" pass-through; the menu item only renders
    // when the host wires this. `blockId` is the decoration-entry id.
    onAskAI?: (blockId: string, output: string) => void;
}

function forwardedKeyBytes(e: React.KeyboardEvent<HTMLDivElement>): string {
    if (e.metaKey || e.ctrlKey || e.altKey) return null;
    if (e.key.length === 1) return e.key;
    if (e.key === "Enter") return "\r";
    if (e.key === "Backspace") return "\x7f";
    if (e.key === "Escape") return "\x1b";
    return null;
}

export const XtermView = memo(
    ({
        outerBlockId,
        fontSize,
        focusRequest = 0,
        topSlot,
        replaceContent,
        blocks = false,
        onAskAI,
    }: XtermViewProps) => {
        const hostRef = useRef<HTMLDivElement>(null);
        const visibleRef = useRef(false);
        const focusedRef = useRef(false);
        const downYRef = useRef<number>(null);
        const inputTextRef = useRef("");
        const paneModel = getXtermPaneModel(outerBlockId);
        const notification = useAtomValue(paneModel.notificationAtom);
        const paneFocusRequest = useAtomValue(paneModel.focusRequestAtom);
        const hasReplace = replaceContent != null;

        const subscribeMode = useCallback(
            (cb: () => void) => subscribeSessionBlockMode(outerBlockId, cb),
            [outerBlockId]
        );
        const getMode = useCallback(() => getSessionBlockMode(outerBlockId), [outerBlockId]);
        const blockMode = useSyncExternalStore(subscribeMode, getMode);
        const promptReady = blockMode === "prompt";

        const [cwd, setCwd] = useState<string>(null);
        const [shellExited, setShellExited] = useState(false);
        const [inputFocusRequest, setInputFocusRequest] = useState(0);

        useEffect(() => {
            if (!notification) return;
            const id = setTimeout(() => {
                globalStore.set(paneModel.notificationAtom, "");
            }, NotificationAutoDismissMs);
            return () => clearTimeout(id);
        }, [notification, paneModel]);

        useEffect(() => {
            if (hasReplace) return;
            const host = hostRef.current;
            if (!host) return;
            const callbacks: SessionCallbacks = {
                onCwd: (next) => setCwd(next),
                onShellExit: () => setShellExited(true),
                onShellRestart: () => setShellExited(false),
            };
            attachSession(outerBlockId, host, callbacks, { blocks });
            // IntersectionObserver covers both scroll-out and ancestor
            // display:none (hidden tabs report isIntersecting=false), which is
            // what drives the session's park/release chain.
            let observer: IntersectionObserver = null;
            if (typeof IntersectionObserver !== "undefined") {
                observer = new IntersectionObserver((entries) => {
                    const entry = entries[entries.length - 1];
                    visibleRef.current = entry.isIntersecting;
                    setSessionVisibility(outerBlockId, entry.isIntersecting, focusedRef.current);
                });
                observer.observe(host);
            } else {
                visibleRef.current = true;
                setSessionVisibility(outerBlockId, true, focusedRef.current);
            }
            return () => {
                observer?.disconnect();
                visibleRef.current = false;
                setSessionVisibility(outerBlockId, false, false);
                detachSession(outerBlockId);
            };
        }, [outerBlockId, hasReplace, blocks]);

        useEffect(() => {
            if (!blocks || hasReplace) return;
            setSessionInputFocus(outerBlockId, () => setInputFocusRequest((n) => n + 1));
            return () => setSessionInputFocus(outerBlockId, null);
        }, [blocks, outerBlockId, hasReplace]);

        useEffect(() => {
            if (hasReplace) return;
            if (focusRequest === 0 && paneFocusRequest === 0) return;
            if (blocks && getSessionBlockMode(outerBlockId) === "prompt") {
                setInputFocusRequest((n) => n + 1);
                return;
            }
            focusSession(outerBlockId);
        }, [focusRequest, paneFocusRequest, outerBlockId, hasReplace, blocks]);

        const onHostFocus = useCallback(() => {
            if (focusedRef.current) return;
            focusedRef.current = true;
            setSessionVisibility(outerBlockId, visibleRef.current, true);
        }, [outerBlockId]);

        const onHostBlur = useCallback(
            (e: React.FocusEvent<HTMLDivElement>) => {
                if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                focusedRef.current = false;
                setSessionVisibility(outerBlockId, visibleRef.current, false);
            },
            [outerBlockId]
        );

        // Pane-scoped key routing. The old engine registered a document-level
        // keydown listener per pane, so with two raw-mode terminals on screen
        // every keystroke was encoded and sent to BOTH ptys (the cross-pane
        // double-send bug). Scoping to the host subtree means a pane only ever
        // sees its own keys. Keys originating from xterm's textarea (a child of
        // this div) are left alone — xterm encodes and forwards them itself via
        // onData/attachCustomKeyEventHandler, exactly like terax's TerminalPane;
        // this handler only catches keys that land on the host div itself (focus
        // fell back to the pane chrome), redirects focus into the terminal, and
        // hand-delivers the first key so it isn't swallowed by the handoff.
        const onHostKeyDown = useCallback(
            (e: React.KeyboardEvent<HTMLDivElement>) => {
                if (e.target !== e.currentTarget) return;
                if (e.nativeEvent.isComposing) return;
                focusSession(outerBlockId);
                const bytes = forwardedKeyBytes(e);
                if (bytes == null) return;
                e.preventDefault();
                writeToSession(outerBlockId, bytes);
            },
            [outerBlockId]
        );

        // Click-to-select a command block; a >4px drag is a text selection and
        // is left to xterm. At the prompt, clicks hand focus back to the input
        // bar (the grid's textarea is disabled there) — mirrors terax's
        // TerminalPane mouse handling.
        const onHostMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
            downYRef.current = e.clientY;
        }, []);
        const onHostMouseUp = useCallback(
            (e: React.MouseEvent<HTMLDivElement>) => {
                const moved = downYRef.current != null && Math.abs(e.clientY - downYRef.current) > 4;
                downYRef.current = null;
                if (!moved) selectSessionBlockAt(outerBlockId, e.clientY);
                if (getSessionBlockMode(outerBlockId) === "prompt") focusSessionInput(outerBlockId);
            },
            [outerBlockId]
        );

        const subscribeBlocks = useCallback(
            (cb: () => void) => subscribeSessionBlocks(outerBlockId, cb),
            [outerBlockId]
        );
        const getVisibleBlocks = useCallback(() => getSessionVisibleBlocks(outerBlockId), [outerBlockId]);
        const readBlockOutput = useCallback((id: string) => readSessionBlockOutput(outerBlockId, id), [outerBlockId]);
        const searchInBlock = useCallback(
            (id: string, query: string) => searchSessionBlock(outerBlockId, id, query),
            [outerBlockId]
        );
        const revealBlockMatch = useCallback(
            (m: BlockMatch) => revealSessionBlockMatch(outerBlockId, m),
            [outerBlockId]
        );
        const clearBlockSearch = useCallback(() => clearSessionBlockSearch(outerBlockId), [outerBlockId]);
        const getWatermarkState = useCallback(() => getSessionWatermarkState(outerBlockId), [outerBlockId]);
        const onRunAgain = useCallback((command: string) => submitToSession(outerBlockId, command), [outerBlockId]);
        const onRestoreFocus = useCallback(() => {
            if (getSessionBlockMode(outerBlockId) === "prompt") focusSessionInput(outerBlockId);
            else focusSession(outerBlockId);
        }, [outerBlockId]);

        const onInputSubmit = useCallback(
            (text: string) => {
                submitToSession(outerBlockId, text);
            },
            [outerBlockId]
        );
        const onInputTextChange = useCallback(
            (text: string) => {
                inputTextRef.current = text;
                setSessionInputActivity(outerBlockId, text.length > 0);
            },
            [outerBlockId]
        );
        // Ctrl+C on an empty prompt buffer interrupts the shell, like a real
        // terminal; with text present it stays a copy/normal key inside the
        // editor. CmdBlockInput has no interrupt hook, so this wraps it.
        const onInputKeyDownCapture = useCallback(
            (e: React.KeyboardEvent<HTMLDivElement>) => {
                if (e.key !== "c" || !e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
                if (inputTextRef.current !== "") return;
                e.preventDefault();
                interruptSession(outerBlockId);
            },
            [outerBlockId]
        );
        const onInputModeChange = useCallback(() => {}, []);

        if (replaceContent != null) {
            return <div className="flex h-full w-full flex-col bg-panel">{replaceContent}</div>;
        }

        return (
            <div className="relative flex h-full w-full flex-col bg-panel">
                {topSlot}
                <div className="relative min-h-0 w-full flex-1">
                    <div
                        ref={hostRef}
                        tabIndex={-1}
                        data-testid="xterm-host"
                        className="absolute inset-0 outline-none"
                        onKeyDown={onHostKeyDown}
                        onFocus={onHostFocus}
                        onBlur={onHostBlur}
                        onMouseDown={blocks ? onHostMouseDown : undefined}
                        onMouseUp={blocks ? onHostMouseUp : undefined}
                    />
                    {blocks && <BlockWatermark subscribe={subscribeBlocks} getState={getWatermarkState} />}
                    {blocks && (
                        <BlockOverlay
                            subscribe={subscribeBlocks}
                            getVisible={getVisibleBlocks}
                            readOutput={readBlockOutput}
                            searchBlock={searchInBlock}
                            revealMatch={revealBlockMatch}
                            clearSearch={clearBlockSearch}
                            promptReady={promptReady}
                            onRunAgain={onRunAgain}
                            onRestoreFocus={onRestoreFocus}
                            onAskAI={onAskAI}
                        />
                    )}
                </div>
                {blocks && (
                    // Hidden (not unmounted) during running/alt so the draft
                    // text and completion state survive a command's lifetime.
                    <div
                        data-testid="xterm-input-bar"
                        className={cn("shrink-0", !promptReady && "hidden")}
                        onKeyDownCapture={onInputKeyDownCapture}
                    >
                        {/* TODO(P2.6): history is component-local until the shared
                            shell-history feed (old TerminalModel context) is rebuilt
                            from cmdblock:row; ssh/git context chips are terminal-mode
                            hidden and need no stub. */}
                        <CmdBlockInput
                            mode="terminal"
                            onModeChange={onInputModeChange}
                            onSubmit={onInputSubmit}
                            cwd={cwd}
                            fontSize={fontSize}
                            focusRequest={inputFocusRequest}
                            hideHelpRow
                            disabled={shellExited}
                            onTextChange={onInputTextChange}
                        />
                    </div>
                )}
                {notification && <TerminalNotification message={notification} />}
            </div>
        );
    }
);
XtermView.displayName = "XtermView";
