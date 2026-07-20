// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Frontend wiring for two extension registration surfaces that used to be
// store-only in crest:
//   - pi.registerShortcut → useAgentExtensionShortcuts binds the registered
//     keys and routes activation back through api.runShortcut().
//   - pi.registerFlag     → AgentFlagsPanel renders a boolean toggle / string
//     input per flag and writes changes back through api.setFlag().
//
// Minimal viable接线: the backend (agent-ipc list-shortcuts/run-shortcut/
// list-flags/set-flag) owns discovery + execution; this file only surfaces
// them in the renderer.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { COMMAND_INLINE_FRAME_CLASSNAME } from "@/app/view/cmdblock/command-inline-frame";
import { getFocusedBlockId } from "@/app/store/global";
import type { AgentChatHostApi } from "./agent-chat-host";

// ---- pi shortcut string matching -------------------------------------------
//
// pi shortcut strings are lowercase, "+"-joined, with the last token as the
// key and preceding tokens as modifiers (ctrl / shift / alt / super). super is
// the meta / cmd key. See pi packages/tui/src/keys.ts parseKeyId/matchesKey.

const SPECIAL_KEY_ALIASES: Record<string, string> = {
    esc: "escape",
    escape: "escape",
    enter: "enter",
    return: "enter",
    tab: "tab",
    space: "space",
    backspace: "backspace",
    delete: "delete",
    insert: "insert",
    home: "home",
    end: "end",
    pageup: "pageup",
    pagedown: "pagedown",
    up: "up",
    down: "down",
    left: "left",
    right: "right",
};

/** Normalize a browser KeyboardEvent.key into pi's lowercase key token. */
function normalizeEventKey(rawKey: string): string {
    switch (rawKey) {
        case "Escape":
            return "escape";
        case "Enter":
            return "enter";
        case "Tab":
            return "tab";
        case " ":
            return "space";
        case "Backspace":
            return "backspace";
        case "Delete":
            return "delete";
        case "Insert":
            return "insert";
        case "Home":
            return "home";
        case "End":
            return "end";
        case "PageUp":
            return "pageup";
        case "PageDown":
            return "pagedown";
        case "ArrowUp":
            return "up";
        case "ArrowDown":
            return "down";
        case "ArrowLeft":
            return "left";
        case "ArrowRight":
            return "right";
        default:
            return rawKey.toLowerCase();
    }
}

interface ParsedShortcut {
    key: string;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    super: boolean;
}

export function parsePiShortcut(shortcut: string): ParsedShortcut | null {
    const parts = shortcut.toLowerCase().split("+");
    if (parts.length === 0) return null;
    const rawKey = parts[parts.length - 1];
    if (!rawKey) return null;
    const key = SPECIAL_KEY_ALIASES[rawKey] ?? rawKey;
    return {
        key,
        ctrl: parts.includes("ctrl"),
        shift: parts.includes("shift"),
        alt: parts.includes("alt"),
        super: parts.includes("super"),
    };
}

export function matchesPiShortcut(event: KeyboardEvent, shortcut: string): boolean {
    const parsed = parsePiShortcut(shortcut);
    if (!parsed) return false;
    if (parsed.ctrl !== event.ctrlKey) return false;
    if (parsed.shift !== event.shiftKey) return false;
    if (parsed.alt !== event.altKey) return false;
    if (parsed.super !== event.metaKey) return false;
    return normalizeEventKey(event.key) === parsed.key;
}

/** True when the shortcut carries a non-shift modifier — safe to intercept
 * without stealing ordinary composer typing. */
function isInterceptableShortcut(shortcut: string): boolean {
    const parsed = parsePiShortcut(shortcut);
    if (!parsed) return false;
    if (parsed.ctrl || parsed.alt || parsed.super) return true;
    // Modifier-less / shift-only bindings on special keys (escape/enter/…) are
    // still safe; a bare printable key is not (it would swallow typing).
    return parsed.key.length > 1;
}

/**
 * Binds extension-registered keyboard shortcuts for the pane. The listener is
 * scoped to when this pane's block is focused so shortcuts don't cross panes.
 * Discovery happens once per cwd via api.listShortcuts(); activation routes
 * through api.runShortcut().
 */
export function useAgentExtensionShortcuts(
    apiRef: RefObject<AgentChatHostApi | null>,
    cwd: string | undefined,
    sessionPath: string | undefined,
    outerBlockId: string,
    reloadToken?: number,
    onUserError?: (message: string) => void
): void {
    const [shortcuts, setShortcuts] = useState<AgentShortcutInfo[]>([]);
    const onUserErrorRef = useRef(onUserError);
    onUserErrorRef.current = onUserError;

    useEffect(() => {
        const api = apiRef.current;
        if (!api || !cwd) {
            setShortcuts([]);
            return;
        }
        let cancelled = false;
        void api
            .listShortcuts()
            .then((list) => {
                if (!cancelled) setShortcuts(list);
            })
            .catch(() => {
                if (!cancelled) setShortcuts([]);
            });
        return () => {
            cancelled = true;
        };
    }, [apiRef, cwd, sessionPath, reloadToken]);

    const interceptable = useMemo(
        () => shortcuts.filter((s) => isInterceptableShortcut(s.shortcut)),
        [shortcuts]
    );

    useEffect(() => {
        if (interceptable.length === 0) return;
        const handler = (event: KeyboardEvent) => {
            if (getFocusedBlockId() !== outerBlockId) return;
            for (const info of interceptable) {
                if (!matchesPiShortcut(event, info.shortcut)) continue;
                event.preventDefault();
                event.stopPropagation();
                void apiRef.current?.runShortcut(info.shortcut).then((result) => {
                    if (result?.status === "noop" && result.message) {
                        onUserErrorRef.current?.(result.message);
                    }
                });
                return;
            }
        };
        window.addEventListener("keydown", handler, true);
        return () => {
            window.removeEventListener("keydown", handler, true);
        };
        // interceptable identity changes only when shortcuts reload.
    }, [apiRef, outerBlockId, interceptable]);
}

// ---- flags panel -----------------------------------------------------------

export interface AgentFlagsPanelProps {
    apiRef: RefObject<AgentChatHostApi | null>;
    cwd: string | undefined;
    sessionPath?: string;
    /** Bumped by the parent to force a reload (e.g. after session mint). */
    reloadToken?: number;
    onUserError?: (message: string) => void;
}

export const AgentFlagsPanel = memo(({ apiRef, cwd, sessionPath, reloadToken, onUserError }: AgentFlagsPanelProps) => {
    const [flags, setFlags] = useState<AgentFlagInfo[]>([]);
    const controlsGenerationRef = useRef(0);
    const reloadRequestRef = useRef(0);
    const reloadTokenRef = useRef(reloadToken);
    const flagWriteQueuesRef = useRef(new Map<string, Promise<void>>());
    const flagWriteVersionsRef = useRef(new Map<string, number>());
    const onUserErrorRef = useRef(onUserError);
    onUserErrorRef.current = onUserError;

    const reload = useCallback(() => {
        const request = ++reloadRequestRef.current;
        const api = apiRef.current;
        if (!api || !cwd) {
            setFlags([]);
            return;
        }
        void api
            .listFlags()
            .then((nextFlags) => {
                if (reloadRequestRef.current === request) setFlags(nextFlags);
            })
            .catch(() => {
                if (reloadRequestRef.current === request) setFlags([]);
            });
    }, [apiRef, cwd, sessionPath]);

    useEffect(() => {
        controlsGenerationRef.current++;
        reload();
        return () => {
            controlsGenerationRef.current++;
            reloadRequestRef.current++;
        };
    }, [reload]);

    useEffect(() => {
        if (reloadTokenRef.current === reloadToken) return;
        reloadTokenRef.current = reloadToken;
        reload();
    }, [reload, reloadToken]);

    const writeFlag = useCallback(
        (name: string, value: boolean | string) => {
            setFlags((prev) => prev.map((f) => (f.name === name ? { ...f, value } : f)));
            const api = apiRef.current;
            if (!api) {
                reload();
                return;
            }
            const version = (flagWriteVersionsRef.current.get(name) ?? 0) + 1;
            const controlsGeneration = controlsGenerationRef.current;
            flagWriteVersionsRef.current.set(name, version);
            const previous = flagWriteQueuesRef.current.get(name) ?? Promise.resolve();
            const operation = previous.then(async () => {
                if (controlsGenerationRef.current !== controlsGeneration) return;
                try {
                    const result = await api.setFlag(name, value);
                    if (result?.status === "noop" && result.message) {
                        onUserErrorRef.current?.(result.message);
                    }
                } catch (err) {
                    onUserErrorRef.current?.(err instanceof Error ? err.message : String(err));
                } finally {
                    if (
                        controlsGenerationRef.current === controlsGeneration &&
                        flagWriteVersionsRef.current.get(name) === version
                    ) {
                        reload();
                    }
                }
            });
            const trackedOperation = operation.finally(() => {
                if (flagWriteQueuesRef.current.get(name) === trackedOperation) {
                    flagWriteQueuesRef.current.delete(name);
                }
            });
            flagWriteQueuesRef.current.set(name, trackedOperation);
            void trackedOperation;
        },
        [apiRef, reload]
    );

    if (flags.length === 0) return null;

    return (
        <div className={`${COMMAND_INLINE_FRAME_CLASSNAME} shrink-0`} data-testid="agent-ext-flags">
            <div className="border-b border-white/[0.07] bg-white/[0.035] px-4 py-2.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-accent">
                Extension Flags
            </div>
            <div className="space-y-2 px-4 py-3 font-mono text-[12px] leading-relaxed">
                {flags.map((flag) => (
                    <AgentFlagRow key={flag.name} flag={flag} onChange={writeFlag} />
                ))}
            </div>
        </div>
    );
});
AgentFlagsPanel.displayName = "AgentFlagsPanel";

const AgentFlagRow = memo(
    ({ flag, onChange }: { flag: AgentFlagInfo; onChange: (name: string, value: boolean | string) => void }) => {
        const value = typeof flag.value === "string" ? flag.value : "";
        const [draft, setDraft] = useState(value);
        useEffect(() => {
            setDraft(value);
        }, [value]);
        const label = (
            <span className="min-w-0">
                <span className="text-foreground">{flag.name}</span>
                {flag.description ? <span className="ml-2 text-secondary/80">{flag.description}</span> : null}
            </span>
        );
        if (flag.type === "boolean") {
            const checked = flag.value === true;
            return (
                <label className="flex cursor-pointer items-center justify-between gap-3">
                    {label}
                    <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => onChange(flag.name, e.target.checked)}
                        className="size-3.5 shrink-0 cursor-pointer accent-accent"
                    />
                </label>
            );
        }
        return (
            <label className="flex items-center justify-between gap-3">
                {label}
                <input
                    type="text"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => {
                        if (draft !== value) onChange(flag.name, draft);
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            e.currentTarget.blur();
                        }
                    }}
                    className="min-w-0 flex-1 rounded-lg border border-white/[0.12] bg-white/[0.045] px-2 py-1 text-foreground outline-none focus:border-accent/60"
                />
            </label>
        );
    }
);
AgentFlagRow.displayName = "AgentFlagRow";
