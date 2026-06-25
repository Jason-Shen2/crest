// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// TerminalView — the top-level React surface for a terminal pane.  Owns the
// TerminalModel for this outer block, mounts the block list, and the input
// bar.  Replaces the old `TermBlocksView` from view/termblocks/termblocks.tsx.

import { CATALOG } from "@/app/store/ai-catalog";
import { providerModelsMapAtom } from "@/app/store/ai-provider-models";
import { resolveAIConfig } from "@/app/store/ai-resolver";
import { AgentSelection, ResolvedAIConfig, ResolveError } from "@/app/store/ai-types";
import { aiUserConfigAtom } from "@/app/store/ai-user-config";
import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { ObjectService } from "@/app/store/services";
import { indexRunsById, type PiRun } from "@/app/store/use-pi-chat";
import { CmdBlockInput, InputMode } from "@/app/view/cmdblock/cmdblock-input";
import { atoms, getApi, useOrefMetaKeyAtom, WOS } from "@/store/global";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContextChipModel } from "../contextchip/chip-model";
import { NLDModel } from "../nld";
import { TerminalModel } from "../terminal-model";
import { AgentActivityBar } from "./agent-activity-bar";
import {
    AgentChatHost,
    type AgentChatHostApi,
    type AgentHostState,
    type AgentSelectorRequest,
} from "./agent-chat-host";
import { AgentSelectorPopover } from "./agent-selector-popover";
import { BlockListElement } from "./block-list-element";
import { FindBar } from "./find-bar";
import { keyEventToBytes } from "./key-bindings";
import { PaletteContext, PaletteOverrides } from "./palette-context";

export interface TerminalViewProps {
    outerBlockId: string;
    fontSize?: number;
    focusRequest?: number;
    // Optional content that mounts *above* the block list — used by the
    // "term" view type when block.meta has `term:vdomtoolbarblockid` set,
    // surfacing a VDom subblock as a toolbar strip.
    topSlot?: React.ReactNode;
    // Optional content that mounts as an absolute-positioned overlay above
    // the rendered terminal.  Currently the agent panel and (future)
    // workspace stickers anchor here.
    overlaySlot?: React.ReactNode;
    // When set, the terminal is replaced entirely by this content.  Used
    // for `term:mode = "vdom"` where the whole pane becomes a single
    // VDom subblock instead of a shell.
    replaceContent?: React.ReactNode;
}

export function blurActiveEditableInRoot(root: HTMLElement | null): void {
    if (!root) return;
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;
    if (!root.contains(active)) return;
    if (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable) {
        active.blur();
    }
}

// One TerminalModel per outerBlockId, cached for the component's lifetime.
// Disposing on unmount cleans up wps subscriptions and the resync timer.
function useTerminalModel(outerBlockId: string): TerminalModel {
    // Stable across renders; recreated only when outerBlockId changes.
    const model = useMemo(() => new TerminalModel(outerBlockId), [outerBlockId]);
    useEffect(() => {
        return () => model.dispose();
    }, [model]);
    return model;
}

// Per-pane NLD model.  Lifecycle parallels TerminalModel: created once
// per outerBlockId, disposed on unmount.  Holds the input mode (locked
// or auto) plus the classifier's effective verdict.
function useNLDModel(outerBlockId: string): NLDModel {
    const model = useMemo(() => new NLDModel(outerBlockId), [outerBlockId]);
    useEffect(() => {
        return () => model.dispose();
    }, [model]);
    return model;
}

// Per-pane context-chip model.  Owns the fingerprint cache + RPC-driven
// fetches that populate the input bar's git/diff/PR/k8s chips.
function useContextChipModel(outerBlockId: string): ContextChipModel {
    const model = useMemo(() => new ContextChipModel(outerBlockId), [outerBlockId]);
    useEffect(() => {
        return () => model.dispose();
    }, [model]);
    return model;
}

export const TerminalView = memo(
    ({ outerBlockId, fontSize = 16, focusRequest = 0, topSlot, overlaySlot, replaceContent }: TerminalViewProps) => {
        const model = useTerminalModel(outerBlockId);
        const loading = useAtomValue(model.loadingAtom);
        const error = useAtomValue(model.errorAtom);
        const revision = useAtomValue(model.revisionAtom);
        const notification = useAtomValue(model.notificationAtom);

        // Palette overrides (OSC 4 / 10 / 11 / 12).  Most users never hit
        // this path so the atoms stay at their empty defaults and the
        // Provider value is reference-stable until a TUI actually writes.
        const paletteMap = useAtomValue(model.paletteOverridesAtom);
        const defaultFg = useAtomValue(model.defaultFgOverrideAtom);
        const defaultBg = useAtomValue(model.defaultBgOverrideAtom);
        const cursorColor = useAtomValue(model.cursorColorOverrideAtom);
        const paletteValue = useMemo<PaletteOverrides>(
            () => ({
                palette: paletteMap,
                defaultFg: defaultFg ?? undefined,
                defaultBg: defaultBg ?? undefined,
                cursorColor: cursorColor ?? undefined,
            }),
            [paletteMap, defaultFg, defaultBg, cursorColor]
        );

        const bellTick = useAtomValue(model.bellTickAtom);
        const commandHistory = useAtomValue(model.commandHistoryAtom);
        const [bellFlash, setBellFlash] = useState(false);

        // Visual bell — C0 BEL bumps bellTick; flash a brief ring around the
        // pane for ~180ms.  Cheap, low-distraction; no audio permission ask.
        useEffect(() => {
            if (bellTick === 0) return;
            setBellFlash(true);
            const id = setTimeout(() => setBellFlash(false), 180);
            return () => clearTimeout(id);
        }, [bellTick]);

        // Auto-dismiss the notification toast after a short window.  We
        // surface OSC 9 / OSC 777 / agent-completion messages here so the
        // user gets a glance without permanent screen clutter.
        useEffect(() => {
            if (!notification) return;
            const id = setTimeout(() => {
                globalStore.set(model.notificationAtom, "");
            }, 3500);
            return () => clearTimeout(id);
        }, [notification, model]);

        // Home dir for prompt-cwd shortening ("~/foo" instead of /Users/.../foo).
        const home = useMemo(() => {
            try {
                return getApi().getHomeDir() ?? "";
            } catch {
                return "";
            }
        }, []);
        // Initial cwd from the outer block's `cmd:cwd` meta — the value the
        // shell was spawned in.  Acts as a fallback before the shell's first
        // OSC precmd sends a live `pwd` update.
        const initialCwd = useOrefMetaKeyAtom(WOS.makeORef("block", outerBlockId), "cmd:cwd");
        // Connection name — empty / "local" / "local:..." → local session;
        // "wsl://..." → WSL; anything else is treated as SSH.  Drives the
        // SshChip in the input bar.
        const connectionName = useOrefMetaKeyAtom(WOS.makeORef("block", outerBlockId), "connection") ?? "";
        const [sshUser, sshHost] = useMemo<[string | undefined, string | undefined]>(() => {
            if (
                !connectionName ||
                connectionName === "local" ||
                connectionName.startsWith("local:") ||
                connectionName.startsWith("wsl://")
            ) {
                return [undefined, undefined];
            }
            const at = connectionName.indexOf("@");
            if (at > 0) {
                return [connectionName.slice(0, at), connectionName.slice(at + 1)];
            }
            return [undefined, connectionName];
        }, [connectionName]);

        // Whichever block is currently running drives input-bar disablement
        // and context (its cwd shows in the strip).
        const liveBlock = useMemo(() => {
            const all = model.getBlocks().all();
            for (let i = all.length - 1; i >= 0; i--) {
                if (all[i].state === "running") return all[i];
            }
            return all[all.length - 1];
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [revision]);
        const [longRunningTick, setLongRunningTick] = useState(0);
        const terminalInputState = useMemo(() => {
            return model.getTerminalInputState();
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [model, revision, longRunningTick, loading]);

        const nld = useNLDModel(outerBlockId);
        const inputMode = useAtomValue(nld.modeAtom);
        const chipModel = useContextChipModel(outerBlockId);
        const chipValues = useAtomValue(chipModel.valuesAtom);
        const effectiveMode = useAtomValue(nld.effectiveModeAtom);

        // AI model picker (Phase D of the ai-config refactor).  Two
        // sources of truth: CATALOG (in-repo) + ~/.config/crest/ai.json
        // (via aiUserConfigAtom).  Selection is persisted per-pane in
        // block.meta["agent:selection"] as a {provider, model, reasoning?}
        // triple.  See docs/ai-config-architecture.md §5.
        const userConfigState = useAtomValue(aiUserConfigAtom);
        const blockAgentSelection = useOrefMetaKeyAtom(WOS.makeORef("block", outerBlockId), "agent:selection");
        // Effective selection — block override beats the ai.json default.
        // Null is a valid state (user hasn't picked, no default) and the
        // picker handles it via its empty/loading banners.
        const activeSelection = useMemo<AgentSelection | null>(() => {
            if (blockAgentSelection?.provider && blockAgentSelection?.model) {
                return {
                    provider: blockAgentSelection.provider,
                    model: blockAgentSelection.model,
                    reasoning: blockAgentSelection.reasoning as "low" | "medium" | "high" | undefined,
                };
            }
            const def = userConfigState.config?.default;
            if (def?.provider && def?.model) {
                return {
                    provider: def.provider,
                    model: def.model,
                    reasoning: def.reasoning as "low" | "medium" | "high" | undefined,
                };
            }
            return null;
        }, [blockAgentSelection, userConfigState.config]);

        const providerModelsMap = useAtomValue(providerModelsMapAtom);

        // Chip label — show just the friendly model name. Resolution order:
        //   1. Catalog displayName (curated)
        //   2. Live /models name (e.g. OpenRouter returns "Anthropic: Claude…")
        //   3. Wire id with any "vendor/" prefix stripped
        // Whatever wins also goes through cleanModelLabel to strip the
        // provider marker baked into many real-world names: catalog uses
        // " (OpenRouter)" suffix, OpenRouter uses "Vendor: " prefix.
        const modelDisplayLabel = useMemo(() => {
            if (!activeSelection) return "Pick model";
            const provider = CATALOG.find((p) => p.id === activeSelection.provider);
            const modelMeta = provider?.models.find((m) => m.id === activeSelection.model);
            const liveMatch = providerModelsMap[activeSelection.provider]?.models.find(
                (m) => m.id === activeSelection.model
            );
            const fallbackId = stripVendorPrefix(activeSelection.model);
            const base = cleanModelLabel(modelMeta?.displayName ?? liveMatch?.name ?? fallbackId);
            return activeSelection.reasoning ? `${base} · ${activeSelection.reasoning}` : base;
        }, [activeSelection, providerModelsMap]);

        const onSelectionChange = useCallback(
            (next: AgentSelection) => {
                void ObjectService.UpdateObjectMeta(WOS.makeORef("block", outerBlockId), {
                    "agent:selection": {
                        provider: next.provider,
                        model: next.model,
                        reasoning: next.reasoning ?? "",
                    },
                });
            },
            [outerBlockId]
        );

        // Resolve the active selection through the catalog + user config
        // into the final wire shape the backend ingests.  Recomputed on
        // every selection / config change.  When the resolver fails
        // (no creds, unknown model, etc.) we keep the structured error so
        // AgentChatHost can surface it inline in the agent block instead of
        // a 3.5s self-dismissing toast.  Note: an absent selection is also
        // surfaced as a synthetic no_default error here so the downstream
        // path is uniform (one nullable error, never both null).
        // Separate config/error pair (instead of a discriminated union here)
        // because the project has `strict: false`, which makes TS unreliable
        // at narrowing `{ ok: true; config } | { ok: false; error }` after a
        // ternary on `.ok`. Returning the pair explicitly sidesteps that.
        const { resolvedAIConfig, aiConfigError } = useMemo<{
            resolvedAIConfig: ResolvedAIConfig | null;
            aiConfigError: ResolveError | null;
        }>(() => {
            if (!activeSelection) {
                return {
                    resolvedAIConfig: null,
                    aiConfigError: {
                        code: "no_default",
                        message: "No model selected. Open the picker or set a default in ai.json.",
                    },
                };
            }
            const r = resolveAIConfig(activeSelection, userConfigState.config ?? undefined, CATALOG);
            if (r.ok) return { resolvedAIConfig: r.config, aiConfigError: null };
            // TS with strict:false doesn't narrow the `!r.ok` branch of the
            // ResolveResult union; assert via the false-branch object shape
            // so we can read `.error` without `// @ts-ignore`.
            const errResult = r as { ok: false; error: ResolveError };
            return { resolvedAIConfig: null, aiConfigError: errResult.error };
        }, [activeSelection, userConfigState.config]);

        // Open the AI setup wizard.  Replaces the earlier "open the JSON
        // file in $EDITOR" affordance — picker now hands off to a guided
        // 2-step modal (provider checkboxes -> API keys)
        // that writes ai.json + keychain entries without the user ever
        // touching the file.
        const onOpenAIConfigFile = useCallback(() => {
            modalsModel.pushModal("AISetupWizard");
        }, []);

        // Feed the chip model with the current cwd / branch + finished-block
        // events.  Each input is a fingerprint dimension (warp's
        // ChipFingerprintInput) — when it changes, the model re-fetches the
        // chips whose policy lists it.
        const liveCwd = liveBlock?.pwd || initialCwd || home;
        const liveBranch = liveBlock?.gitBranch;
        useEffect(() => {
            if (liveCwd) chipModel.setCwd(liveCwd);
        }, [chipModel, liveCwd]);
        useEffect(() => {
            chipModel.setGitBranch(liveBranch);
        }, [chipModel, liveBranch]);

        // Per-completed-block invalidation pass.  Mirrors warp's
        // `invalidate_on_commands`: we look for blocks that have transitioned
        // to a finished state since the last revision tick and feed their
        // command lines to the chip model.  The Set persists across renders
        // via a ref so each block is reported at most once.
        const reportedCompletionRef = useRef<Set<string>>(new Set());
        useEffect(() => {
            const all = model.getBlocks().all();
            for (const b of all) {
                if (b.state !== "done-with-execution") continue;
                if (reportedCompletionRef.current.has(b.id)) continue;
                reportedCompletionRef.current.add(b.id);
                const cmd = b.cmd ?? "";
                if (cmd) chipModel.onCommandCompleted(cmd);
            }
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [revision, chipModel]);
        const setInputMode = useCallback(
            (next: InputMode, currentText?: string) => {
                nld.setMode(next);
                // When toggling Auto *on* with existing buffer content, fire a
                // one-shot classifier run so the effective mode reflects the
                // current text immediately — without this the stale value
                // persists until the next keystroke.
                if (next === "auto" && currentText && currentText.trim().length > 0) {
                    // isAgentFollowUp is wired to false until crest's block
                    // engine surfaces a "last block was AI" signal.
                    nld.triggerDetectionImmediate(currentText, commandHistory, false);
                }
            },
            [nld, commandHistory]
        );
        const onInputTextChange = useCallback(
            (next: string) => {
                // For now we don't have a "last block was AI" signal in
                // crest's block list, so isAgentFollowUp is always false.
                // Wire it in once the agent block-type lands.
                nld.onTextChange(next, commandHistory, false);
            },
            [nld, commandHistory]
        );
        const [submitting, setSubmitting] = useState(false);

        // ---------- agent wiring ----------
        //
        // AgentChatHost owns usePiChat for this pane. It exposes a small
        // API (send / abort / getRuns) via onReady so cmdblock-input can
        // submit and the timeline can render runs. block.meta["agent:session"]
        // is the persistent pane→session link; first send mints metadata,
        // onSessionMintedHandler writes it back to meta.
        const agentApiRef = useRef<AgentChatHostApi | null>(null);
        const onAgentHostReady = useCallback((api: AgentChatHostApi) => {
            agentApiRef.current = api;
        }, []);
        const [modelPickerRequest, setModelPickerRequest] = useState(0);
        const onOpenAgentModelPicker = useCallback(() => {
            setModelPickerRequest((value) => value + 1);
        }, []);
        const [agentSelectorRequest, setAgentSelectorRequest] = useState<AgentSelectorRequest | null>(null);
        const onAgentSelectorRequest = useCallback((request: AgentSelectorRequest) => {
            setAgentSelectorRequest(request);
        }, []);
        const [agentRestoredTextRequest, setAgentRestoredTextRequest] = useState<
            { text: string; requestId: number } | undefined
        >(undefined);
        const onAgentEditorText = useCallback((text: string) => {
            setAgentRestoredTextRequest((prev) => ({ text, requestId: (prev?.requestId ?? 0) + 1 }));
        }, []);
        // Reactive agent state (status + pending queue) for the activity bar above
        // the input. The host's onReady api is imperative; this is the live view.
        const [agentState, setAgentState] = useState<AgentHostState>({
            status: "idle",
            queuedMessages: [],
        });
        const onAgentStop = useCallback(() => {
            agentApiRef.current?.abort();
        }, []);
        const persistedAgentSession = useOrefMetaKeyAtom(WOS.makeORef("block", outerBlockId), "agent:session");
        const timelineAgentSessionPath = useMemo(() => model.getFirstAgentSessionPath(), [model, revision]);
        const agentSession = useMemo<AgentSessionMeta | undefined>(() => {
            if (persistedAgentSession?.path) return persistedAgentSession;
            if (!timelineAgentSessionPath) return undefined;
            return {
                id: "",
                createdAt: "",
                cwd: liveCwd,
                path: timelineAgentSessionPath,
            };
        }, [persistedAgentSession, timelineAgentSessionPath, liveCwd]);
        const onSessionMintedHandler = useCallback(
            (meta: AgentSessionMeta) => {
                void ObjectService.UpdateObjectMeta(WOS.makeORef("block", outerBlockId), {
                    "agent:session": meta,
                });
            },
            [outerBlockId]
        );
        // Renderer state for agent runs. AgentChatHost watches usePiChat
        // and announces runIds to the model; here we read the same source
        // (via the API) to feed AgentBlockElement via BlockListElement.
        // For the timeline render we keep the runs map in a small state
        // hook updated on each api refresh.
        const [agentRunsById, setAgentRunsById] = useState<Map<string, PiRun>>(new Map());
        const onAgentRunsUpdate = useCallback((runs: PiRun[]) => {
            setAgentRunsById(indexRunsById(runs));
        }, []);
        const tabId = useAtomValue(atoms.staticTabId);
        const recentCmds = useMemo(() => commandHistory.slice(-10), [commandHistory]);
        const liveConnection = useMemo(() => connectionName || "", [connectionName]);

        // V1 file-citation jump.  Proper "scroll to the block whose output
        // touched this file" requires a filename→block index we don't have
        // yet — until then we copy `filename:line` to clipboard so the user
        // can paste into their editor.  Real scroll-to-block is a P-future
        // punch list item.
        const onAgentFileJump = useCallback(
            (filename: string, line?: number) => {
                const ref = line != null ? `${filename}:${line}` : filename;
                try {
                    void navigator.clipboard.writeText(ref);
                    globalStore.set(model.notificationAtom, `Copied ${ref}`);
                } catch {
                    // sandbox / permissions failure — drop silently
                }
            },
            [model]
        );

        // V1 open-block — when a tool-use card carries a blockid (e.g. the
        // headless shell block that ran a shell_exec call), let the user
        // scroll the timeline to that block.  Works for blocks already in
        // this pane; "open hidden block" UX is future polish.
        const onAgentOpenBlock = useCallback(
            (blockId: string) => {
                const found = model.getBlocks().findById(blockId);
                if (!found) {
                    globalStore.set(model.notificationAtom, `Block ${blockId} is not in this pane`);
                    return;
                }
                model.setScrollPosition({ kind: "anchored", blockId });
            },
            [model]
        );

        const onSubmit = useCallback(
            (text: string, mode: InputMode) => {
                if (!text) return;
                if (mode === "agent") {
                    const api = agentApiRef.current;
                    if (!api) {
                        globalStore.set(model.notificationAtom, "Agent is still starting. Try again in a moment.");
                        return false;
                    }
                    return api.submit(text);
                }
                setSubmitting(true);
                void model.submitInput(text).finally(() => setSubmitting(false));
            },
            [model]
        );

        const onCopyBlock = useCallback(
            (oid: string) => {
                const block = model.getBlocks().findById(oid);
                if (!block) return;
                // Concatenate visible cells row-by-row.  Skip width=0 (right half
                // of wide cells); trim trailing whitespace per line.
                const grid = block.outputGrid.raw();
                const lines: string[] = [];
                for (let r = 0; r < grid.rowCount(); r++) {
                    const row = grid.getRow(r);
                    let s = "";
                    for (const cell of row) {
                        if (!cell) continue;
                        if (cell.width === 0) continue;
                        s += cell.char || " ";
                    }
                    lines.push(s.replace(/\s+$/g, ""));
                }
                navigator.clipboard.writeText(lines.join("\n"));
            },
            [model]
        );

        const isRunning = liveBlock?.state === "running";
        const inAltScreen = terminalInputState.kind !== "input-editor";
        const rootRef = useRef<HTMLDivElement>(null);

        useEffect(() => {
            const delay = model.nextLongRunningCheckDelayMs();
            if (delay == null) return;
            const timeout = setTimeout(() => setLongRunningTick((tick) => tick + 1), delay);
            return () => clearTimeout(timeout);
        }, [model, revision]);

        useEffect(() => {
            if (!inAltScreen) return;
            blurActiveEditableInRoot(rootRef.current);
        }, [inAltScreen]);

        // OSC 8 link click — open in user's default browser.
        const onLinkClick = useCallback((uri: string) => {
            try {
                getApi().openExternal(uri);
            } catch {
                // Preview / test envs without preload — fall back to a tab.
                window.open(uri, "_blank", "noopener,noreferrer");
            }
        }, []);

        // Alt-screen keystroke routing.  When a TUI is live (vim, htop, less,
        // lazygit, fzf), any key that lands on the document — but not on the
        // input textarea — goes straight to PTY.  Encoding honors the current
        // terminal mode (APP_CURSOR variants, modifier-aware long forms).
        useEffect(() => {
            if (!inAltScreen) return;
            const onKeyDown = (e: KeyboardEvent) => {
                const target = e.target as HTMLElement | null;
                if (target) {
                    const tag = target.tagName;
                    if (tag === "TEXTAREA" || tag === "INPUT" || target.isContentEditable) {
                        return;
                    }
                }
                const bytes = keyEventToBytes(e, model.getMode());
                if (bytes != null) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.stopImmediatePropagation();
                    void model.sendBytes(bytes);
                }
            };
            document.addEventListener("keydown", onKeyDown);
            return () => document.removeEventListener("keydown", onKeyDown);
        }, [inAltScreen, model]);

        // Alt-screen paste routing.  Bracketed-paste mode (DEC 2004) wraps
        // the pasted text in ESC[200~ / ESC[201~ so the running app can tell
        // paste from typed-in characters (vim auto-indent, fish completion).
        useEffect(() => {
            if (!inAltScreen) return;
            const onPaste = (e: ClipboardEvent) => {
                const target = e.target as HTMLElement | null;
                if (
                    target &&
                    (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)
                ) {
                    return;
                }
                const text = e.clipboardData?.getData("text") ?? "";
                if (!text) return;
                e.preventDefault();
                const mode = model.getMode();
                const payload = mode.bracketedPaste ? `\x1b[200~${text}\x1b[201~` : text;
                void model.sendBytes(payload);
            };
            document.addEventListener("paste", onPaste);
            return () => document.removeEventListener("paste", onPaste);
        }, [inAltScreen, model]);

        // Document-level mouseup ends a drag-selection.  Per-block handlers
        // can finalize too, but if the user releases the button outside any
        // block (input bar, gap between blocks, off-window) we'd otherwise
        // leak the dragging state and every subsequent move would keep
        // extending the focus.
        useEffect(() => {
            const onMouseUp = () => {
                model.endSelection();
            };
            document.addEventListener("mouseup", onMouseUp);
            return () => document.removeEventListener("mouseup", onMouseUp);
        }, [model]);

        // Focus reporting (DEC 1004).  When the running app turns this on,
        // ESC[I goes out on window focus, ESC[O on blur.  vim's :autoread,
        // fish's reactive UI, neovim's autocmd FocusGained/Lost all use this.
        useEffect(() => {
            const onFocus = () => {
                if (model.getMode().focusReport) {
                    void model.sendBytes("\x1b[I");
                }
            };
            const onBlur = () => {
                if (model.getMode().focusReport) {
                    void model.sendBytes("\x1b[O");
                }
            };
            window.addEventListener("focus", onFocus);
            window.addEventListener("blur", onBlur);
            return () => {
                window.removeEventListener("focus", onFocus);
                window.removeEventListener("blur", onBlur);
            };
        }, [model]);

        // cols measurement — track the pane's monospace-char width and update
        // the model when the column count changes.  The model uses the new
        // cols for *future* blocks; running blocks have their geometry already
        // baked in, but we still notify the PTY via sendResize so the shell's
        // line-editing math stays correct.
        // charWidth is held in *state* (not just a ref) so it flows down into
        // BlockListElement as a prop — block-level mouse-to-cell math needs
        // the value for SelectionLayer rectangles.
        const [charWidth, setCharWidth] = useState(7.2);
        useEffect(() => {
            const el = rootRef.current;
            if (!el) return;
            const measure = () => {
                const probe = document.createElement("span");
                // Use the grid's exact font stack — Tailwind's `font-mono`
                // resolves through whatever the project's theme defines.
                // Inline an explicit font-family here would silently diverge
                // from the rendered text whenever the chain falls back past
                // ui-monospace (e.g. on Linux), causing the SelectionLayer
                // to come up a few pixels short on the right edge.
                probe.className = "font-mono";
                probe.style.cssText = `position:absolute;visibility:hidden;font-size:${fontSize}px;white-space:pre;line-height:1;`;
                probe.textContent = "M".repeat(80);
                el.appendChild(probe);
                const cw = probe.getBoundingClientRect().width / 80;
                el.removeChild(probe);
                if (cw > 0) setCharWidth((prev) => (Math.abs(prev - cw) > 0.05 ? cw : prev));
                const rect = el.getBoundingClientRect();
                const paneWidth = rect.width;
                const cols = Math.max(20, Math.floor(paneWidth / (cw > 0 ? cw : 7.2)));
                // Compute rows from actual pane height — TUIs that span the
                // whole pane (vim, htop, lazygit) get the geometry their
                // protocol asks for, instead of a hardcoded 24.
                const lineHeightForResize = Math.round(fontSize * 1.4);
                const paneHeight = rect.height;
                const rows = Math.max(10, Math.floor(paneHeight / lineHeightForResize));
                if (cols !== model.cols) {
                    model.setCols(cols);
                }
                void model.sendResize(rows, cols);
            };
            measure();
            // Webfont (Hack) loads asynchronously via FontFace.  The first
            // measure() typically runs before Hack is ready, picking up the
            // narrower `monospace` fallback width.  Re-measure once fonts
            // are ready so SelectionLayer / FindHighlight / mouse-to-cell
            // math all use the real glyph advance.
            let cancelled = false;
            const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
            if (fonts) {
                fonts.ready.then(() => {
                    if (!cancelled) measure();
                });
            }
            const ro = new ResizeObserver(measure);
            ro.observe(el);
            return () => {
                cancelled = true;
                ro.disconnect();
            };
        }, [fontSize, model]);

        // Cmd+C / Ctrl+C — copy the current selection.  Only when there's an
        // active selection; otherwise let the default keystroke pass through
        // (Ctrl+C while running a command sends SIGINT via the input handler).
        useEffect(() => {
            const onKeyDown = (e: KeyboardEvent) => {
                const isCopy = (e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C");
                if (!isCopy) return;
                // Don't fight the textarea — Cmd+C inside the input bar should
                // copy from the input, not the terminal.
                const target = e.target as HTMLElement | null;
                if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
                void model.copySelection().then((copied) => {
                    if (copied) {
                        e.preventDefault();
                    }
                });
            };
            document.addEventListener("keydown", onKeyDown);
            return () => document.removeEventListener("keydown", onKeyDown);
        }, [model]);

        // Cmd+F / Ctrl+F — toggle the find bar.
        useEffect(() => {
            const onKeyDown = (e: KeyboardEvent) => {
                const isFind = (e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F");
                if (!isFind) return;
                e.preventDefault();
                model.toggleFindVisible();
            };
            document.addEventListener("keydown", onKeyDown);
            return () => document.removeEventListener("keydown", onKeyDown);
        }, [model]);

        // Cmd/Ctrl + ArrowUp / ArrowDown — block-level navigation.  Skips
        // when focus is in the input bar or any other editable area so the
        // user can still navigate command-line text with arrow keys.
        useEffect(() => {
            const onKeyDown = (e: KeyboardEvent) => {
                if (!(e.metaKey || e.ctrlKey)) return;
                if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                const target = e.target as HTMLElement | null;
                if (
                    target &&
                    (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable)
                ) {
                    return;
                }
                e.preventDefault();
                if (e.key === "ArrowUp") model.selectPreviousBlock();
                else model.selectNextBlock();
            };
            document.addEventListener("keydown", onKeyDown);
            return () => document.removeEventListener("keydown", onKeyDown);
        }, [model]);

        // Cmd/Ctrl + Shift + S — toggle the snackbar (sticky pinned prompt).
        // The dismiss button on the snackbar itself only hides; this is the
        // re-show / global toggle affordance.
        useEffect(() => {
            const onKeyDown = (e: KeyboardEvent) => {
                if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
                if (e.key !== "s" && e.key !== "S") return;
                e.preventDefault();
                model.toggleSnackbarVisible();
            };
            document.addEventListener("keydown", onKeyDown);
            return () => document.removeEventListener("keydown", onKeyDown);
        }, [model]);

        // OSC 0/1/2 title → document.title.  Electron's window title mirrors
        // document.title, so the shell's set-title escapes surface in the
        // OS window chrome.  Multiple terminal panes will fight for the
        // global slot; last-mounted wins, which matches what most users
        // expect (a freshly-focused terminal updates the window title).
        const title = useAtomValue(model.titleAtom);
        useEffect(() => {
            if (!title) return;
            const prev = document.title;
            document.title = title;
            return () => {
                // Restore previous title when this terminal unmounts or
                // the title clears, so a stale value doesn't linger.
                document.title = prev;
            };
        }, [title]);

        // Agent overlay is not wired in this engine revision.  The legacy
        // term-agent.tsx (ai-sdk's useChat host + TermAgentOverlay) was built
        // for the pre-migration TermBlocksViewModel / TermViewModel data
        // shape; reattaching it as-is causes a render-loop freeze.  Proper
        // reconnection is Track C in docs/term-engine-migration.md — needs a
        // ground-up design for TerminalModel rather than a recovered file.

        // Full-screen replace path: when the caller hands us a `replaceContent`
        // we render only that — used by `term:mode = "vdom"` to show a VDom
        // subblock instead of a shell.  We still mount our hidden measurement
        // host so any future return to terminal mode has fresh cols ready.
        if (replaceContent != null) {
            return (
                <PaletteContext.Provider value={paletteValue}>
                    <div ref={rootRef} className="flex h-full w-full flex-col bg-panel">
                        {replaceContent}
                    </div>
                </PaletteContext.Provider>
            );
        }

        return (
            <PaletteContext.Provider value={paletteValue}>
                <div
                    ref={rootRef}
                    className={cn(
                        // bg-panel (translucent, matches vtabbar/treeview on the left)
                        // instead of bg-background (opaque) so gradient themes like
                        // Cyber Wave paint through to the body's --bg-gradient.  For
                        // solid themes the visual delta is negligible — bg-panel
                        // resolves to a faint foreground tint at 50% alpha over the
                        // same body color.
                        "relative flex h-full w-full flex-col bg-panel transition-shadow",
                        bellFlash && "ring-2 ring-inset ring-amber-400/50"
                    )}
                >
                    {topSlot}
                    <FindBar model={model} />
                    <AgentChatHost
                        outerBlockId={outerBlockId}
                        sessionMetadata={agentSession}
                        onSessionMinted={onSessionMintedHandler}
                        modelSelection={
                            resolvedAIConfig
                                ? {
                                      // Resolved config carries the credential ref
                                      // (tokensecretname / token) main needs to find
                                      // the provider API key — activeSelection alone
                                      // doesn't, which left agent sends keyless.
                                      provider: resolvedAIConfig.provider,
                                      model: resolvedAIConfig.model,
                                      reasoning: resolvedAIConfig.reasoning,
                                      token: resolvedAIConfig.token,
                                      tokenSecretName: resolvedAIConfig.tokensecretname,
                                  }
                                : activeSelection
                                  ? {
                                        provider: activeSelection.provider,
                                        model: activeSelection.model,
                                        reasoning: activeSelection.reasoning,
                                    }
                                  : undefined
                        }
                        paneContext={{
                            cwd: liveCwd,
                            gitBranch: liveBlock?.gitBranch ?? chipValues.gitBranch,
                            recentCmds,
                            connection: liveConnection,
                        }}
                        selectionError={aiConfigError}
                        onReady={onAgentHostReady}
                        onRunsChange={onAgentRunsUpdate}
                        onStateChange={setAgentState}
                        onUserError={(msg) => globalStore.set(model.notificationAtom, msg)}
                        onOpenModelPicker={onOpenAgentModelPicker}
                        onSelectorRequest={onAgentSelectorRequest}
                    />
                    {error && (
                        <div className="shrink-0 border-b border-rose-500/30 bg-rose-500/10 px-3 py-1 text-[12px] text-rose-300">
                            {error}
                        </div>
                    )}
                    {loading && model.getBlocks().length() === 0 ? (
                        <div className="flex flex-1 items-center justify-center text-[12px] text-secondary/70">
                            Loading terminal…
                        </div>
                    ) : (
                        <BlockListElement
                            model={model}
                            fontSize={fontSize}
                            home={home}
                            onCopyBlock={onCopyBlock}
                            onLinkClick={onLinkClick}
                            charWidth={charWidth}
                            agentRunsById={agentRunsById}
                        />
                    )}
                    {/* prompt_to_editor_padding — warp settings/mod.rs:551 keeps a
                10px breathing room between the last block's output and the
                top of the input editor.  Without this the input's border-t
                hugs the last command's stdout. */}
                    {!inAltScreen && <div className="mt-2.5" />}
                    {/* Agent footer (warp's bottom orchestration bar): working status +
                Stop on the right, queued messages on the left. Between the
                conversation and the input editor; hidden when idle + empty. */}
                    {!inAltScreen && (
                        <AgentActivityBar
                            status={agentState.status}
                            queuedMessages={agentState.queuedMessages}
                            onStop={onAgentStop}
                        />
                    )}
                    {!inAltScreen && (
                        <CmdBlockInput
                            cwd={liveCwd}
                            home={home}
                            // Branch prefers the precmd value (instant) and falls back
                            // to the chip-model fetch (covers shells with no precmd).
                            branch={liveBlock?.gitBranch || chipValues.gitBranch}
                            venv={liveBlock?.virtualEnv}
                            nodeVersion={liveBlock?.nodeVersion}
                            // Diff stats: precmd if shell sent it, else chip-model.
                            gitAdded={liveBlock?.gitDiffAdded ?? chipValues.gitDiffAdded}
                            gitRemoved={liveBlock?.gitDiffRemoved ?? chipValues.gitDiffRemoved}
                            prNumber={chipValues.prNumber}
                            prTitle={chipValues.prTitle}
                            kubernetesContext={chipValues.kubernetesContext}
                            sshHost={sshHost}
                            sshUser={sshUser}
                            mode={inputMode}
                            onModeChange={setInputMode}
                            onSubmit={onSubmit}
                            submitting={submitting}
                            disabled={false}
                            fontSize={fontSize}
                            focusRequest={focusRequest}
                            history={commandHistory}
                            onTextChange={onInputTextChange}
                            restoredTextRequest={agentRestoredTextRequest}
                            effectiveMode={effectiveMode}
                            modelDisplayLabel={modelDisplayLabel}
                            catalog={CATALOG}
                            userConfig={userConfigState.config}
                            userConfigStatus={userConfigState.status}
                            userConfigError={userConfigState.error}
                            selection={activeSelection}
                            onSelectionChange={onSelectionChange}
                            onOpenAIConfigFile={onOpenAIConfigFile}
                            openModelPickerRequest={modelPickerRequest}
                            placeholder={
                                isRunning
                                    ? "Press Ctrl+C in the running block to interrupt, or type the next command"
                                    : undefined
                            }
                        />
                    )}
                    <AgentSelectorPopover
                        request={agentSelectorRequest}
                        onClose={() => setAgentSelectorRequest(null)}
                        onUserMessage={(msg) => globalStore.set(model.notificationAtom, msg)}
                        onEditorText={onAgentEditorText}
                    />
                    {overlaySlot}
                    {notification && (
                        <div className="pointer-events-none absolute right-3 top-3 max-w-[60%] rounded border border-fg-overlay-2 bg-background/95 px-3 py-2 text-[12px] text-foreground shadow-lg">
                            {notification}
                        </div>
                    )}
                </div>
            </PaletteContext.Provider>
        );
    }
);
TerminalView.displayName = "TerminalView";

// stripVendorPrefix — OpenRouter / Together style model ids carry the
// upstream vendor as a slash-prefixed namespace ("anthropic/claude-…").
// The chip should surface just the model name, not the vendor segment.
function stripVendorPrefix(modelId: string): string {
    const i = modelId.lastIndexOf("/");
    if (i < 0 || i === modelId.length - 1) return modelId;
    return modelId.slice(i + 1);
}

// cleanModelLabel — display labels arrive with the provider baked in,
// in two flavors:
//   - " (OpenRouter)" suffix on the curated catalog displayName
//   - "Vendor: " prefix on the live /models name for OpenRouter etc.
// Both look like noise in the chip. Strip them so the chip shows just
// the model. The detail tooltip still surfaces the provider explicitly.
function cleanModelLabel(label: string): string {
    let s = label.replace(/\s*\([^)]*\)\s*$/, "");
    const idx = s.indexOf(": ");
    if (idx > 0 && idx < s.length - 2) {
        s = s.slice(idx + 2);
    }
    return s.trim();
}
