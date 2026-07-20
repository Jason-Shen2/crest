// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentChatHost owns the React hook lifecycle for the active Agent
// session and mirrors the main-owned turns into WorkspaceAgentSurface's assistant-ui
// runtime.
//
// Replaces the pre-pi version which mounted @ai-sdk/react useChat and
// translated UIMessage parts into ai-sdk's WaveUIDataToolUse shape
// via TerminalModel.applyAgentParts. Post-pi: messages live in
// usePiChat state, and WorkspaceAgentSurface bridges those turns into assistant-ui.
//
// Returns null — purely a state-bridge component. UI lives in WorkspaceAgentSurface.

import { useEffect, useRef } from "react";

import type { ResolveError } from "@/app/store/ai-types";
import {
    usePiChat,
    type PiAgentMessage,
    type PiExtUiState,
    type PiTurn,
    type UsePiChatModel,
    type UsePiChatPaneContext,
    type UsePiChatStatus,
} from "@/app/store/use-pi-chat";
import { resolveAgentSlashCommandRoute, type AgentSlashCommandName } from "./agent-slash-command-routing";

export interface AgentChatHostProps {
    outerBlockId: string;
    /** Persisted session metadata from block.meta["agent:session"]. Undefined → first send mints one. */
    sessionMetadata?: AgentSessionMeta;
    /** Called once when usePiChat receives the new metadata after first send. */
    onSessionMinted?: (meta: AgentSessionMeta) => void;
    /** Resolved model selection (provider/model/reasoning) from the picker + resolver. */
    modelSelection?: UsePiChatModel;
    /** Pane context (cwd / git / recent cmds / connection) fed into the system prompt. */
    paneContext: UsePiChatPaneContext;
    /**
     * When the model selection failed to resolve (no API key, unknown model,
     * etc.), this carries the structured error so submit attempts can be
     * routed to an inline error block instead of silently dropped.
     */
    selectionError?: ResolveError | null;
    /** Wired once with a send fn the input bar can call. Mirrors the previous useChat host's pattern. */
    onReady?: (api: AgentChatHostApi) => void;
    /** Changes when extension discovery must rerun after an explicit reload. */
    extensionRefreshToken?: number;
    /** Called when usePiChat adopts a different canonical session. */
    onSessionPathChange?: (sessionPath: string | undefined) => void;
    /** Called on every turns change so WorkspaceAgentSurface can feed assistant-ui. */
    onTurnsChange?: (turns: PiTurn[]) => void;
    /**
     * Called when the agent's live status or pending queue changes. Drives the
     * activity bar above the input (streaming indicator + Stop + queued chips).
     */
    onStateChange?: (state: AgentHostState) => void;
    /**
     * Called on every extension ctx.ui state change (statuses / widgets / the
     * active confirm/select/input prompt). Drives the inline ext-ui panel.
     */
    onExtUiChange?: (extUi: PiExtUiState) => void;
    /** Per-pane tool allowlist; undefined = main defaults to allowAll (v1). */
    allowedTools?: string[];
    /** Notification atom setter — surface user-facing errors when send can't proceed. */
    onUserError?: (message: string) => void;
    /** Pi-style inline command result feedback for immediate slash commands. */
    onCommandResult?: (result: AgentInlineCommandResult) => void;
    /** Opens the real model picker owned by the input component. */
    onOpenModelPicker?: () => void;
    /** Selector-first command path for Task7 UI: /tree and /fork never self-resolve from text. */
    onSelectorRequest?: (request: AgentSelectorRequest) => void;
}

/** Reactive agent state surfaced to the parent for the activity bar. */
export interface AgentHostState {
    status: UsePiChatStatus;
    /** Messages queued behind the current run (ordered steer-first). */
    queuedMessages: PiAgentMessage[];
}

/** Functions exposed via onReady for the input bar / parent. */
export interface AgentChatHostApi {
    /** Route agent slash commands, otherwise send a user prompt. */
    submit: (text: string) => boolean;
    /** Send a user prompt. Idempotent if called twice with the same text — pi will queue. */
    send: (text: string) => boolean;
    /** List the current session tree for selector UI. */
    listTree: () => Promise<AgentTreeResult>;
    /** List forkable user-message points for selector UI. */
    listForkPoints: () => Promise<AgentForkPointView[]>;
    /** Navigate to a selected tree entry. */
    navigateTree: (targetId: string) => Promise<AgentNavigateTreeResult>;
    /** Fork from a selected entry. */
    forkSession: (entryId: string) => Promise<AgentForkSessionResult>;
    /** Clone the current branch immediately. */
    cloneSession: () => Promise<AgentCloneSessionResult>;
    /** Abort the in-flight run, if any. */
    abort: () => void;
    /** Answer the active extension ctx.ui prompt (confirm/select/input). */
    respondExtUi: (requestId: string, result: unknown) => void;
    /** Deliver a widget interaction from renderer to a live extension UI surface. */
    respondWidgetEvent: (event: AgentWidgetEvent) => void;
    /** List extension-registered keyboard shortcuts (pi.registerShortcut). */
    listShortcuts: () => Promise<AgentShortcutInfo[]>;
    /** Activate an extension keyboard shortcut by its key string. */
    runShortcut: (shortcut: string) => Promise<AgentCommandExecutionResult>;
    /** List extension-registered flags (pi.registerFlag) with live values. */
    listFlags: () => Promise<AgentFlagInfo[]>;
    /** Write an extension flag value (only durable when a live session owns the pane). */
    setFlag: (name: string, value: boolean | string) => Promise<AgentCommandExecutionResult>;
    /** Current turns for diagnostics / future selectors. */
    getTurns: () => PiTurn[];
}

export type AgentSelectorRequest =
    | {
          type: "tree";
          listTree: () => Promise<AgentTreeResult>;
          navigateTree: (targetId: string) => Promise<AgentNavigateTreeResult>;
      }
    | {
          type: "fork";
          listForkPoints: () => Promise<AgentForkPointView[]>;
          forkSession: (entryId: string) => Promise<AgentForkSessionResult>;
      }
    | {
          type: "resume";
          cwd: string;
          listSessions: (cwd?: string) => Promise<AgentSessionDetail[]>;
          resumeSession: (sessionMetadata: AgentSessionMeta) => Promise<AgentNavigateTreeResult>;
      };

export function getAgentExtensionDiscoveryKey(
    cwd: string | undefined,
    sessionPath: string | undefined,
    refreshToken = 0
): string {
    return JSON.stringify([cwd ?? "", sessionPath ?? "", refreshToken]);
}

export interface AgentCommandExecutionResult {
    status?: "success" | "noop";
    message?: string;
    sessionMetadata?: AgentSessionMeta;
}

type AgentImmediateCommandName = Exclude<AgentSlashCommandName, "tree" | "fork" | "clone" | "model">;

export interface AgentInlineCommandResult {
    // Built-in immediate command names get literal autocomplete; extension
    // commands surface their registered name (any string) via the same feedback
    // list. The `(string & {})` keeps the literal union for editors.
    command: AgentImmediateCommandName | (string & {});
    status: "success" | "noop";
    message: string;
    sessionMetadata?: AgentSessionMeta;
}

interface AgentChatHostApiDeps {
    sendPrompt: (text: string) => boolean;
    abort: () => void;
    respondExtUi: (requestId: string, result: unknown) => void;
    respondWidgetEvent?: (event: AgentWidgetEvent) => void;
    getTurns: () => PiTurn[];
    getRuntimeApi: () => AgentRuntimeApi | undefined;
    getSessionMetadata: () => AgentSessionMeta | undefined;
    getPaneCwd: () => string;
    /** Parent terminal block ID, used by backend commands that need pane identity. */
    getBlockId: () => string;
    runCommand?: (command: AgentImmediateCommandName, argsText: string) => Promise<AgentCommandExecutionResult>;
    /** Execute an extension-registered command (pi.registerCommand) by name. */
    runExtensionCommand?: (name: string, argsText: string) => Promise<AgentCommandExecutionResult>;
    /** Names of extension-registered commands, so submit() can route them instead of prompting. */
    getExtensionCommandNames?: () => ReadonlySet<string>;
    onSessionMinted?: (meta: AgentSessionMeta) => void;
    onCommandResult?: (result: AgentInlineCommandResult) => void;
    onUserError?: (message: string) => void;
    onOpenModelPicker?: () => void;
    onSelectorRequest?: (request: AgentSelectorRequest) => void;
}

export function createAgentChatHostApi(deps: AgentChatHostApiDeps): AgentChatHostApi {
    const requireRuntimeApi = (): AgentRuntimeApi => {
        const runtimeApi = deps.getRuntimeApi();
        if (!runtimeApi) {
            throw new Error("Electron agent IPC not available (window.api.agent missing)");
        }
        return runtimeApi;
    };
    const requireSessionMetadata = (): AgentSessionMeta => {
        const sessionMetadata = deps.getSessionMetadata();
        if (!sessionMetadata?.path) {
            throw new Error("No agent session yet. Send a prompt before using session commands.");
        }
        return sessionMetadata;
    };
    const listTree = async (): Promise<AgentTreeResult> => {
        return await requireRuntimeApi().listTree(requireSessionMetadata());
    };
    const listForkPoints = async (): Promise<AgentForkPointView[]> => {
        return await requireRuntimeApi().listForkPoints(requireSessionMetadata());
    };
    const listSessions = async (cwd?: string): Promise<AgentSessionDetail[]> => {
        const runtimeApi = requireRuntimeApi();
        if (cwd) {
            return await runtimeApi.listSessionDetailsForCwd(cwd);
        }
        return await runtimeApi.listAllSessionDetails();
    };
    const navigateTree = async (targetId: string): Promise<AgentNavigateTreeResult> => {
        return await requireRuntimeApi().navigateTree({
            sessionMetadata: requireSessionMetadata(),
            targetId,
            blockId: deps.getBlockId(),
        });
    };
    const forkSession = async (entryId: string): Promise<AgentForkSessionResult> => {
        const result = await requireRuntimeApi().forkSession({
            sessionMetadata: requireSessionMetadata(),
            cwd: deps.getPaneCwd(),
            entryId,
        });
        deps.onSessionMinted?.(result.sessionMetadata);
        return result;
    };
    const resumeSession = async (sessionMetadata: AgentSessionMeta): Promise<AgentNavigateTreeResult> => {
        deps.onSessionMinted?.(sessionMetadata);
        return { sessionMetadata };
    };
    const cloneSession = async (): Promise<AgentCloneSessionResult> => {
        const result = await requireRuntimeApi().cloneSession({
            sessionMetadata: requireSessionMetadata(),
            cwd: deps.getPaneCwd(),
        });
        if (result.sessionMetadata) {
            deps.onSessionMinted?.(result.sessionMetadata);
        }
        if (result.message) {
            deps.onUserError?.(result.message);
        }
        return result;
    };
    const reportAsyncError = (promise: Promise<unknown>): void => {
        void promise.catch((err) => deps.onUserError?.(err instanceof Error ? err.message : String(err)));
    };
    const runImmediateCommand = (command: AgentImmediateCommandName, argsText: string): boolean => {
        if (!deps.runCommand) {
            deps.onUserError?.(`Agent command /${command} is not available yet.`);
            return true;
        }
        reportAsyncError(
            deps.runCommand(command, argsText).then((result) => {
                if (result.sessionMetadata) {
                    deps.onSessionMinted?.(result.sessionMetadata);
                }
                if (result.message) {
                    deps.onCommandResult?.({
                        command,
                        status: result.status ?? "success",
                        message: result.message,
                        sessionMetadata: result.sessionMetadata,
                    });
                }
            })
        );
        return true;
    };
    const isImmediateCommand = (command: AgentSlashCommandName): command is AgentImmediateCommandName => {
        return command !== "tree" && command !== "fork" && command !== "clone" && command !== "model";
    };
    const runExtensionCommand = (name: string, argsText: string): boolean => {
        if (!deps.runExtensionCommand) {
            deps.onUserError?.(`Extension command /${name} is not available.`);
            return true;
        }
        reportAsyncError(
            deps.runExtensionCommand(name, argsText).then((result) => {
                if (result.message) {
                    deps.onCommandResult?.({
                        command: name,
                        status: result.status ?? "success",
                        message: result.message,
                    });
                }
            })
        );
        return true;
    };
    const listShortcuts = async (): Promise<AgentShortcutInfo[]> => {
        return await requireRuntimeApi().listShortcuts(deps.getPaneCwd());
    };
    const runShortcut = async (shortcut: string): Promise<AgentCommandExecutionResult> => {
        return await requireRuntimeApi().runShortcut({
            sessionMetadata: deps.getSessionMetadata(),
            cwd: deps.getPaneCwd(),
            shortcut,
        });
    };
    const listFlags = async (): Promise<AgentFlagInfo[]> => {
        return await requireRuntimeApi().listFlags(deps.getPaneCwd(), deps.getSessionMetadata());
    };
    const setFlag = async (name: string, value: boolean | string): Promise<AgentCommandExecutionResult> => {
        return await requireRuntimeApi().setFlag({
            sessionMetadata: deps.getSessionMetadata(),
            name,
            value,
        });
    };
    return {
        submit: (text) => {
            const route = resolveAgentSlashCommandRoute(text, deps.getExtensionCommandNames?.());
            if (!route.handled) {
                return deps.sendPrompt(text);
            }
            if (route.kind === "extension") {
                return runExtensionCommand(route.name, route.argsText);
            }
            if (route.command === "model") {
                deps.onOpenModelPicker?.();
                return true;
            }
            if (route.command === "tree") {
                deps.onSelectorRequest?.({ type: "tree", listTree, navigateTree });
                return true;
            }
            if (route.command === "fork") {
                deps.onSelectorRequest?.({ type: "fork", listForkPoints, forkSession });
                return true;
            }
            if (route.command === "resume") {
                deps.onSelectorRequest?.({ type: "resume", cwd: deps.getPaneCwd(), listSessions, resumeSession });
                return true;
            }
            if (isImmediateCommand(route.command)) {
                return runImmediateCommand(route.command, route.argsText);
            }
            reportAsyncError(cloneSession());
            return true;
        },
        send: deps.sendPrompt,
        listTree,
        listForkPoints,
        navigateTree,
        forkSession,
        cloneSession,
        abort: deps.abort,
        respondExtUi: deps.respondExtUi,
        respondWidgetEvent: (event) => deps.respondWidgetEvent?.(event),
        listShortcuts,
        runShortcut,
        listFlags,
        setFlag,
        getTurns: deps.getTurns,
    };
}

export function AgentChatHost({
    outerBlockId,
    sessionMetadata,
    onSessionMinted,
    modelSelection,
    paneContext,
    selectionError,
    onReady,
    extensionRefreshToken,
    onSessionPathChange,
    onTurnsChange,
    onStateChange,
    onExtUiChange,
    allowedTools,
    onUserError,
    onCommandResult,
    onOpenModelPicker,
    onSelectorRequest,
}: AgentChatHostProps) {
    // usePiChat doesn't accept a undefined modelSelection (send needs
    // provider+model). We feed it a synthetic placeholder when the
    // resolver hasn't produced one yet so the hook can mount; send()
    // below short-circuits with an error before actually calling the
    // hook's send if the real selection isn't ready.
    const effectiveSelection: UsePiChatModel = modelSelection ?? {
        provider: "",
        model: "",
    };

    const chat = usePiChat({
        initialSession: sessionMetadata,
        onSessionMinted,
        paneContext,
        modelSelection: effectiveSelection,
        allowedTools,
        blockId: outerBlockId,
    });

    const turns = chat.turns;
    const onTurnsChangeRef = useRef(onTurnsChange);
    onTurnsChangeRef.current = onTurnsChange;
    const onUserErrorRef = useRef(onUserError);
    onUserErrorRef.current = onUserError;
    const onCommandResultRef = useRef(onCommandResult);
    onCommandResultRef.current = onCommandResult;
    const onOpenModelPickerRef = useRef(onOpenModelPicker);
    onOpenModelPickerRef.current = onOpenModelPicker;
    const onSessionMintedRef = useRef(onSessionMinted);
    onSessionMintedRef.current = onSessionMinted;
    const onSelectorRequestRef = useRef(onSelectorRequest);
    onSelectorRequestRef.current = onSelectorRequest;
    useEffect(() => {
        onTurnsChangeRef.current?.(turns);
    }, [turns]);

    // Expose the send/abort API to the parent via onReady. Refs keep
    // the callback closure stable across renders while still reading
    // the latest model state, selection error, and chat handle.
    const sendRef = useRef(chat.send);
    const abortRef = useRef(chat.abort);
    const turnsRef = useRef(turns);
    const sessionMetadataRef = useRef(chat.sessionMetadata);
    const paneContextRef = useRef(paneContext);
    const selectionErrorRef = useRef(selectionError);
    const modelSelectionRef = useRef(modelSelection);
    sendRef.current = chat.send;
    abortRef.current = chat.abort;
    turnsRef.current = turns;
    sessionMetadataRef.current = chat.sessionMetadata;
    paneContextRef.current = paneContext;
    selectionErrorRef.current = selectionError;
    modelSelectionRef.current = modelSelection;

    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;
    const onSessionPathChangeRef = useRef(onSessionPathChange);
    onSessionPathChangeRef.current = onSessionPathChange;
    useEffect(() => {
        onSessionPathChangeRef.current?.(chat.sessionMetadata?.path);
    }, [chat.sessionMetadata?.path]);
    // Surface live status + pending queue to the parent (the activity bar).
    const onStateChangeRef = useRef(onStateChange);
    onStateChangeRef.current = onStateChange;
    useEffect(() => {
        onStateChangeRef.current?.({ status: chat.status, queuedMessages: chat.queuedMessages });
    }, [chat.status, chat.queuedMessages]);

    // Surface the extension ctx.ui state (statuses / widgets / active prompt).
    const onExtUiChangeRef = useRef(onExtUiChange);
    onExtUiChangeRef.current = onExtUiChange;
    const respondExtUiRef = useRef(chat.respondExtUi);
    respondExtUiRef.current = chat.respondExtUi;
    const respondWidgetEventRef = useRef(chat.respondWidgetEvent);
    respondWidgetEventRef.current = chat.respondWidgetEvent;
    useEffect(() => {
        onExtUiChangeRef.current?.(chat.extUi);
    }, [chat.extUi]);

    // Extension-registered command names for this pane's cwd. Loaded lazily so
    // submit() can route "/name" to the extension ctx instead of prompting the
    // LLM. Refreshed whenever the pane cwd changes.
    const extensionCommandNamesRef = useRef<ReadonlySet<string>>(new Set<string>());
    const extensionDiscoveryKey = getAgentExtensionDiscoveryKey(
        paneContext.cwd,
        chat.sessionMetadata?.path,
        extensionRefreshToken
    );
    useEffect(() => {
        const cwd = paneContext.cwd;
        if (!cwd) return;
        let cancelled = false;
        const runtimeApi = getAgentRuntimeApi();
        void runtimeApi
            ?.listCommands(cwd)
            .then((commands) => {
                if (cancelled) return;
                extensionCommandNamesRef.current = new Set(
                    commands.filter((c) => c.source === "extension").map((c) => c.name)
                );
            })
            .catch(() => {
                // Extension discovery failures shouldn't break submit; leave the
                // previous names in place.
            });
        return () => {
            cancelled = true;
        };
    }, [extensionDiscoveryKey]);

    // One-shot wiring of the API. Stable identity so re-renders don't
    // tear down whatever the parent stored.
    useEffect(() => {
        const sendPrompt = (text: string): boolean => {
            const trimmed = text.trim();
            if (!trimmed) return false;
            // Block sends when no model is resolved (e.g. ai.json
            // missing, no API key). Surface the resolver error so
            // the user sees a specific reason rather than nothing.
            if (!modelSelectionRef.current) {
                const msg =
                    selectionErrorRef.current?.message ??
                    "AI is not configured. Open the model picker to set up a provider and pick a model.";
                onUserErrorRef.current?.(msg);
                return false;
            }
            void sendRef.current(trimmed);
            return true;
        };
        const api = createAgentChatHostApi({
            sendPrompt,
            abort: () => abortRef.current(),
            respondExtUi: (requestId, result) => respondExtUiRef.current(requestId, result),
            respondWidgetEvent: (event) => respondWidgetEventRef.current(event),
            getTurns: () => turnsRef.current,
            getRuntimeApi: getAgentRuntimeApi,
            getSessionMetadata: () => sessionMetadataRef.current,
            getPaneCwd: () => paneContextRef.current.cwd,
            getBlockId: () => outerBlockId,
            onSessionMinted: (meta) => onSessionMintedRef.current?.(meta),
            onCommandResult: (result) => onCommandResultRef.current?.(result),
            onUserError: (message) => onUserErrorRef.current?.(message),
            onOpenModelPicker: () => onOpenModelPickerRef.current?.(),
            onSelectorRequest: (request) => onSelectorRequestRef.current?.(request),
            runCommand: async (command, argsText) => {
                const runtimeApi = getAgentRuntimeApi();
                if (!runtimeApi) {
                    throw new Error("Electron agent IPC not available (window.api.agent missing)");
                }
                return await runtimeApi.runCommand({
                    sessionMetadata: sessionMetadataRef.current,
                    cwd: paneContextRef.current.cwd,
                    command,
                    argsText,
                    blockId: outerBlockId,
                });
            },
            runExtensionCommand: async (name, argsText) => {
                const runtimeApi = getAgentRuntimeApi();
                if (!runtimeApi) {
                    throw new Error("Electron agent IPC not available (window.api.agent missing)");
                }
                return await runtimeApi.runExtensionCommand({
                    sessionMetadata: sessionMetadataRef.current,
                    cwd: paneContextRef.current.cwd,
                    name,
                    argsText,
                    blockId: outerBlockId,
                });
            },
            getExtensionCommandNames: () => extensionCommandNamesRef.current,
        });
        onReadyRef.current?.(api);
        // Re-fire when the API identity is stable; we want one-shot,
        // but tolerating an extra fire on remount is harmless because
        // the parent overwrites the ref unconditionally.
    }, []);

    return null;
}

interface AgentRuntimeApi {
    listSessionsForCwd: (cwd: string) => Promise<AgentSessionMeta[]>;
    listSessionDetailsForCwd: (cwd: string, limit?: number) => Promise<AgentSessionDetail[]>;
    listAllSessionDetails: (limit?: number) => Promise<AgentSessionDetail[]>;
    listCommands: (cwd?: string) => Promise<AgentCommandInfo[]>;
    listTree: (sessionMetadata: AgentSessionMeta) => Promise<AgentTreeResult>;
    listForkPoints: (sessionMetadata: AgentSessionMeta) => Promise<AgentForkPointView[]>;
    navigateTree: (input: AgentNavigateTreeInput) => Promise<AgentNavigateTreeResult>;
    forkSession: (input: AgentForkSessionInput) => Promise<AgentForkSessionResult>;
    cloneSession: (input: AgentCloneSessionInput) => Promise<AgentCloneSessionResult>;
    runCommand: (input: AgentRunCommandInput) => Promise<AgentCommandExecutionResult>;
    runExtensionCommand: (input: AgentRunExtensionCommandInput) => Promise<AgentCommandExecutionResult>;
    listShortcuts: (cwd?: string) => Promise<AgentShortcutInfo[]>;
    runShortcut: (input: AgentRunShortcutInput) => Promise<AgentCommandExecutionResult>;
    listFlags: (cwd?: string, sessionMetadata?: AgentSessionMeta) => Promise<AgentFlagInfo[]>;
    setFlag: (input: AgentSetFlagInput) => Promise<AgentCommandExecutionResult>;
}

function getAgentRuntimeApi(): AgentRuntimeApi | undefined {
    if (typeof window === "undefined") return undefined;
    return (window as unknown as { api?: { agent?: AgentRuntimeApi } }).api?.agent;
}
