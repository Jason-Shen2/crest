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
// Input bar and block decorations arrive in P3 (docs/terax-terminal-port.md).

import { globalStore } from "@/app/store/jotaiStore";
import { TerminalNotification } from "@/app/term/render/terminal-notification";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useRef } from "react";
import { getXtermPaneModel } from "./xterm-pane-model";
import { attachSession, detachSession, focusSession, setSessionVisibility, writeToSession } from "./xterm-session";

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
}

function forwardedKeyBytes(e: React.KeyboardEvent<HTMLDivElement>): string {
    if (e.metaKey || e.ctrlKey || e.altKey) return null;
    if (e.key.length === 1) return e.key;
    if (e.key === "Enter") return "\r";
    if (e.key === "Backspace") return "\x7f";
    if (e.key === "Escape") return "\x1b";
    return null;
}

export const XtermView = memo(({ outerBlockId, focusRequest = 0, topSlot, replaceContent }: XtermViewProps) => {
    const hostRef = useRef<HTMLDivElement>(null);
    const visibleRef = useRef(false);
    const focusedRef = useRef(false);
    const paneModel = getXtermPaneModel(outerBlockId);
    const notification = useAtomValue(paneModel.notificationAtom);
    const paneFocusRequest = useAtomValue(paneModel.focusRequestAtom);
    const hasReplace = replaceContent != null;

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
        attachSession(outerBlockId, host, {}, { blocks: false });
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
    }, [outerBlockId, hasReplace]);

    useEffect(() => {
        if (hasReplace) return;
        if (focusRequest === 0 && paneFocusRequest === 0) return;
        focusSession(outerBlockId);
    }, [focusRequest, paneFocusRequest, outerBlockId, hasReplace]);

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

    if (replaceContent != null) {
        return <div className="flex h-full w-full flex-col bg-panel">{replaceContent}</div>;
    }

    return (
        <div className="relative flex h-full w-full flex-col bg-panel">
            {topSlot}
            <div
                ref={hostRef}
                tabIndex={-1}
                data-testid="xterm-host"
                className="min-h-0 w-full flex-1 outline-none"
                onKeyDown={onHostKeyDown}
                onFocus={onHostFocus}
                onBlur={onHostBlur}
            />
            {notification && <TerminalNotification message={notification} />}
        </div>
    );
});
XtermView.displayName = "XtermView";
