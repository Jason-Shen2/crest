// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { CATALOG } from "@/app/store/ai-catalog";
import { providerModelsMapAtom } from "@/app/store/ai-provider-models";
import { resolveAIConfig } from "@/app/store/ai-resolver";
import { AgentSelection, ResolvedAIConfig, ResolveError } from "@/app/store/ai-types";
import { aiUserConfigAtom } from "@/app/store/ai-user-config";
import {
    contextSendDisabledReason,
    createContextReferenceState,
    resolveContextReferenceUiConfig,
    type ContextReferenceSendDisabledReason,
} from "@/app/store/context-references";
import { EmptyRewindState, type PiAgentMessage, type PiTurn } from "@/app/store/use-pi-chat";
import { ModelPickerInline } from "@/app/view/cmdblock/model-picker-popover";
import { SessionSelector } from "@/app/view/cmdblock/session-selector";
import type { WorkspaceAgentModel } from "@/app/workspace/workspace-agent-model";
import { Button } from "@/shadcn/ui/button";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    AgentChatHost,
    type AgentChatHostApi,
    type AgentComposerRestorePayload,
    type AgentHostState,
    type AgentInlineCommandResult,
    type AgentSelectorRequest,
} from "./agent-chat-host";
import { AgentCommandCard } from "./agent-command-card";
import { AgentCommandResultList } from "./agent-command-result";
import type { AgentRuntimeClient } from "./agent-runtime-client";
import { isAgentSlashCommandReadOnly } from "./agent-slash-command-routing";
import {
    AssistantRuntimeProvider,
    ContextReferenceBar,
    Thread,
    useAui,
    useCrestAssistantRuntime,
} from "./assistant-ui";
import type { CrestContextUsage } from "./assistant-ui/context-display";
import { CheckpointQuotaBanner } from "./rewind/checkpoint-quota-banner";
import { CheckpointQuotaDialog, type CheckpointPurgeRequest } from "./rewind/checkpoint-quota-dialog";
import { DiffReviewDialog } from "./rewind/diff-review-dialog";
import { RecoveryDialog } from "./rewind/recovery-dialog";
import { RedoDock } from "./rewind/redo-dock";
import { RewindSelector } from "./rewind/rewind-selector";
import { useAgentRewind } from "./rewind/use-agent-rewind";

export interface AgentContentProps {
    model: WorkspaceAgentModel;
    client: AgentRuntimeClient;
    executionContext: AgentExecutionContext;
    onOpenFile?: (path: string) => void;
}

interface AgentAttachedPanelState {
    commandResults: AgentInlineCommandResult[];
    selectorRequest: AgentSelectorRequest | null;
    modelPickerOpen: boolean;
}

interface AgentComposerTextRequest {
    text: string;
    requestId: number;
    sessionPath?: string;
    sessionRevision: number;
}

interface AgentRevealTurnRequest {
    turnId: string;
    requestId: number;
    sessionPath?: string;
    sessionRevision: number;
}

interface AgentRevealResolver {
    finish(revealed: boolean, clearRequest?: boolean): void;
}

interface RecoveryUiState {
    open: boolean;
    phase: "idle" | "loading" | "resolving" | "error";
    recovery?: AgentWorkspaceRecoveryView;
    errorMessage?: string;
}

interface CheckpointQuotaUiState {
    open: boolean;
    phase: "idle" | "loading" | "ready" | "purging" | "error";
    owners: AgentCheckpointTrashOwnerView[];
    staleOwnerIds: string[];
    errorMessage?: string;
}

const RevealTurnTimeoutMs = 5_000;

function emptyAttachedPanelState(): AgentAttachedPanelState {
    return {
        commandResults: [],
        selectorRequest: null,
        modelPickerOpen: false,
    };
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageField(usage: Record<string, unknown>, ...keys: string[]): number | undefined {
    for (const key of keys) {
        const value = finiteNumber(usage[key]);
        if (value != null) return value;
    }
    return undefined;
}

function uiErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function mapPiUsageToContextUsage(usage: unknown): CrestContextUsage | undefined {
    if (!usage || typeof usage !== "object") return undefined;
    const value = usage as Record<string, unknown>;
    const inputTokens = usageField(value, "inputTokens", "input");
    const outputTokens = usageField(value, "outputTokens", "output");
    const cacheRead = usageField(value, "cachedInputTokens", "cacheRead") ?? 0;
    const cacheWrite = usageField(value, "cacheWrite") ?? 0;
    const cachedInputTokens = cacheRead + cacheWrite;
    const reasoningTokens = usageField(value, "reasoningTokens");
    const totalTokens =
        usageField(value, "totalTokens") ??
        (inputTokens ?? 0) + (outputTokens ?? 0) + cachedInputTokens + (reasoningTokens ?? 0);

    if (!inputTokens && !outputTokens && !cachedInputTokens && !reasoningTokens && !totalTokens) return undefined;
    return {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        cachedInputTokens,
        ...(reasoningTokens != null ? { reasoningTokens } : {}),
        totalTokens,
    };
}

export function getLatestAgentContextUsage(turns: PiTurn[]): CrestContextUsage | undefined {
    for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        for (let j = turn.responseMessages.length - 1; j >= 0; j--) {
            const message = turn.responseMessages[j];
            if (message.role !== "assistant") continue;
            if (message.stopReason === "aborted" || message.stopReason === "error") continue;
            const usage = mapPiUsageToContextUsage(message.usage);
            if (usage) return usage;
        }
    }
    return undefined;
}

function stripVendorPrefix(modelId: string): string {
    const i = modelId.lastIndexOf("/");
    if (i < 0 || i === modelId.length - 1) return modelId;
    return modelId.slice(i + 1);
}

function cleanModelLabel(label: string): string {
    let s = label.replace(/\s*\([^)]*\)\s*$/, "");
    const idx = s.indexOf(": ");
    if (idx > 0 && idx < s.length - 2) {
        s = s.slice(idx + 2);
    }
    return s.trim();
}

function getQueuedMessageText(message: PiAgentMessage): string {
    const textParts: string[] = [];
    let imageCount = 0;
    for (const content of message.content ?? []) {
        if (content.type === "text" && typeof content.text === "string") {
            const text = content.text.trim();
            if (text) textParts.push(text);
            continue;
        }
        if (content.type === "image") {
            imageCount++;
        }
    }
    const text = textParts.join(" ");
    if (text) return text;
    if (imageCount === 1) return "Image attachment";
    if (imageCount > 1) return `${imageCount} image attachments`;
    return "Queued message";
}

function QueuedMessagesPanel({ messages }: { messages: PiAgentMessage[] }) {
    if (messages.length === 0) return null;
    return (
        <details open className="overflow-hidden rounded-2xl border border-white/[0.10] bg-[rgba(34,34,36,0.62)]">
            <summary className="cursor-pointer px-3 py-2 text-sm">{messages.length} queued</summary>
            <div className="grid gap-px border-t border-white/[0.065] p-1">
                {messages.map((message, index) => (
                    <div className="truncate px-2.5 py-1.5 text-sm" key={index}>
                        {getQueuedMessageText(message)}
                    </div>
                ))}
            </div>
        </details>
    );
}

function AgentInlineError({ message, onDismiss }: { message: string; onDismiss: () => void }) {
    if (!message) return null;
    return (
        <div
            className="flex items-start justify-between gap-3 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-sm text-red-100"
            role="alert"
        >
            <span>{message}</span>
            <button
                aria-label="Dismiss error"
                className="cursor-pointer text-red-100/70 transition-colors hover:text-red-100"
                onClick={onDismiss}
                type="button"
            >
                ×
            </button>
        </div>
    );
}

function AgentInlineNotification({ message, onDismiss }: { message: string; onDismiss: () => void }) {
    if (!message) return null;
    return (
        <div
            aria-live="polite"
            className="flex items-start justify-between gap-3 rounded-xl border border-white/15 bg-white/[0.07] px-3 py-2 text-sm text-white/80"
            role="status"
        >
            <span>{message}</span>
            <button
                aria-label="Dismiss notification"
                className="cursor-pointer text-white/50 transition-colors hover:text-white/80"
                onClick={onDismiss}
                type="button"
            >
                ×
            </button>
        </div>
    );
}

function ComposerTextRestore({
    request,
    sessionPath,
    sessionRevision,
}: {
    request?: AgentComposerTextRequest;
    sessionPath?: string;
    sessionRevision: number;
}) {
    const aui = useAui();
    const consumedRequestRef = useRef("");
    useEffect(() => {
        if (!request || request.sessionPath !== sessionPath || request.sessionRevision !== sessionRevision) {
            return;
        }
        const requestKey = `${request.sessionPath ?? ""}\u0000${request.sessionRevision}\u0000${request.requestId}`;
        if (consumedRequestRef.current === requestKey) return;
        consumedRequestRef.current = requestKey;
        aui.composer().setText(request.text);
    }, [aui, request, sessionPath, sessionRevision]);
    return null;
}

function makeEmptyHostState(
    sessionPath: string | undefined,
    sessionRevision: number,
    contextReferencesEnabled: boolean
): AgentHostState {
    return {
        sessionPath,
        sessionRevision,
        status: "idle",
        queuedMessages: [],
        commands: [],
        rewindState: EmptyRewindState,
        context: {
            ...createContextReferenceState(sessionPath),
            enabled: contextReferencesEnabled,
        },
    };
}

export function agentContextSendGuidance(reason: ContextReferenceSendDisabledReason): string {
    if (reason === "feature_disabled") {
        return "Context references are disabled in ai.json. Remove them or enable context references before sending.";
    }
    if (reason === "summary_not_ready") {
        return "Prepare the missing Summary, or choose Full or Metadata before sending.";
    }
    if (reason === "references_sending") {
        return "These references are already sending. Wait for that request to finish.";
    }
    return "";
}

export function AgentContent({ model, client, executionContext, onOpenFile }: AgentContentProps) {
    const [attachedPanelState, setAttachedPanelState] = useState<AgentAttachedPanelState>(emptyAttachedPanelState);
    const userConfigState = useAtomValue(aiUserConfigAtom);
    const contextReferenceUiConfig = useMemo(() => resolveContextReferenceUiConfig(userConfigState), [userConfigState]);
    const contextReferencesEnabled = contextReferenceUiConfig.enabled;
    const agentStateValue = useAtomValue(model.stateAtom);
    const sessionRevision = useAtomValue(model.sessionGenerationAtom);
    const modelErrorMessage = useAtomValue(model.errorAtom);
    const providerModelsMap = useAtomValue(providerModelsMapAtom);
    const activeSelection = useMemo<AgentSelection | null>(() => {
        if (agentStateValue.selection?.provider && agentStateValue.selection?.model) {
            return {
                provider: agentStateValue.selection.provider,
                model: agentStateValue.selection.model,
                reasoning: agentStateValue.selection.reasoning as "low" | "medium" | "high" | undefined,
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
    }, [agentStateValue.selection, userConfigState.config]);
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
    const resolved = useMemo<{ resolvedAIConfig: ResolvedAIConfig | null; aiConfigError: ResolveError | null }>(() => {
        if (!activeSelection) {
            return {
                resolvedAIConfig: null,
                aiConfigError: {
                    code: "no_default",
                    message: "No model selected. Open the picker or set a default in ai.json.",
                },
            };
        }
        const result = resolveAIConfig(activeSelection, userConfigState.config ?? undefined, CATALOG);
        if ("config" in result) return { resolvedAIConfig: result.config, aiConfigError: null };
        return { resolvedAIConfig: null, aiConfigError: result.error };
    }, [activeSelection, userConfigState.config]);
    const agentApiRef = useRef<AgentChatHostApi | null>(null);
    const composerAnchorRef = useRef<HTMLDivElement>(null);
    const activeSessionPath = agentStateValue.activeSession?.path;
    const operationScopeKey = `${activeSessionPath ?? ""}\u0000${sessionRevision}`;
    const operationScopeRef = useRef(operationScopeKey);
    operationScopeRef.current = operationScopeKey;
    const recoveryEpochRef = useRef(0);
    const quotaCleanupEpochRef = useRef(0);
    const quotaDialogEpochRef = useRef(0);
    const quotaMaintenanceLeaseRef = useRef<{ scopeKey: string; token: symbol } | undefined>(undefined);
    const consumedPurgeTokensRef = useRef(new Set<string>());
    const [recoveryUi, setRecoveryUi] = useState<RecoveryUiState>({
        open: false,
        phase: "idle",
    });
    const [quotaBusy, setQuotaBusy] = useState(false);
    const [quotaUi, setQuotaUi] = useState<CheckpointQuotaUiState>({
        open: false,
        phase: "idle",
        owners: [],
        staleOwnerIds: [],
    });
    const [agentRestoredTextRequest, setAgentRestoredTextRequest] = useState<AgentComposerTextRequest>();
    const [revealTurnRequest, setRevealTurnRequest] = useState<AgentRevealTurnRequest>();
    const revealRequestIdRef = useRef(0);
    const revealResolversRef = useRef(new Map<number, AgentRevealResolver>());
    const [receivedHostState, setReceivedHostState] = useState<AgentHostState>(() =>
        makeEmptyHostState(activeSessionPath, sessionRevision, contextReferencesEnabled)
    );
    const hostStateRef = useRef(receivedHostState);
    const hostState = useMemo(
        () =>
            receivedHostState.sessionPath === activeSessionPath && receivedHostState.sessionRevision === sessionRevision
                ? receivedHostState
                : makeEmptyHostState(activeSessionPath, sessionRevision, contextReferencesEnabled),
        [activeSessionPath, contextReferencesEnabled, receivedHostState, sessionRevision]
    );
    const currentRevealTurnRequest =
        revealTurnRequest?.sessionPath === activeSessionPath && revealTurnRequest?.sessionRevision === sessionRevision
            ? { turnId: revealTurnRequest.turnId, requestId: revealTurnRequest.requestId }
            : undefined;
    const [dismissedHostError, setDismissedHostError] = useState<string>();
    const [dismissedModelError, setDismissedModelError] = useState<string>();
    const [userErrorMessage, setUserErrorMessage] = useState("");
    const [userNotification, setUserNotification] = useState<{ message: string; generation: number }>();
    const userErrorMessageRef = useRef("");
    const userErrorWriteGenerationRef = useRef(0);
    const [agentTurns, setAgentTurns] = useState<PiTurn[]>([]);
    const [rewindSelectedPath, setRewindSelectedPath] = useState<string>();
    const visibleError =
        hostState.errorMessage && hostState.errorMessage !== dismissedHostError
            ? { source: "host" as const, message: hostState.errorMessage }
            : modelErrorMessage && modelErrorMessage !== dismissedModelError
              ? { source: "model" as const, message: modelErrorMessage }
              : userErrorMessage
                ? { source: "user" as const, message: userErrorMessage }
                : undefined;

    useEffect(() => {
        if (!modelErrorMessage) {
            setDismissedModelError(undefined);
        }
    }, [modelErrorMessage]);

    useEffect(() => {
        setAttachedPanelState((current) => {
            if (!current.selectorRequest || current.selectorRequest.isCurrent?.() !== false) {
                return current;
            }
            return { ...current, selectorRequest: null };
        });
    }, [sessionRevision]);

    const onUserError = useCallback((message: string) => {
        userErrorMessageRef.current = message;
        userErrorWriteGenerationRef.current++;
        setUserErrorMessage(message);
    }, []);
    const onUserMessage = useCallback((message: string) => {
        setUserNotification((current) => ({
            message,
            generation: (current?.generation ?? 0) + 1,
        }));
    }, []);
    const enqueueComposerText = useCallback((payload: AgentComposerRestorePayload) => {
        setAgentRestoredTextRequest((previous) => ({
            ...payload,
            requestId: (previous?.requestId ?? 0) + 1,
        }));
    }, []);
    const onEditorText = useCallback(
        (text: string) => {
            enqueueComposerText({ text, sessionPath: activeSessionPath, sessionRevision });
        },
        [activeSessionPath, enqueueComposerText, sessionRevision]
    );
    const cancelPendingReveals = useCallback((clearRequest = true): void => {
        for (const resolver of revealResolversRef.current.values()) resolver.finish(false, clearRequest);
        revealResolversRef.current.clear();
    }, []);
    const onRevealTurn = useCallback(
        async (turnId: string, signal: AbortSignal): Promise<boolean> => {
            cancelPendingReveals();
            if (signal.aborted) return false;
            const requestId = ++revealRequestIdRef.current;
            const completion = new Promise<boolean>((resolve) => {
                let timeout = 0;
                const finish = (revealed: boolean, clearRequest = true): void => {
                    const resolver = revealResolversRef.current.get(requestId);
                    if (!resolver || resolver.finish !== finish) return;
                    window.clearTimeout(timeout);
                    signal.removeEventListener("abort", onAbort);
                    revealResolversRef.current.delete(requestId);
                    if (clearRequest) {
                        setRevealTurnRequest((current) => (current?.requestId === requestId ? undefined : current));
                    }
                    resolve(revealed);
                };
                const onAbort = (): void => finish(false);
                revealResolversRef.current.set(requestId, { finish });
                signal.addEventListener("abort", onAbort, { once: true });
                timeout = window.setTimeout(() => finish(false), RevealTurnTimeoutMs);
            });
            setRevealTurnRequest({
                turnId,
                requestId,
                sessionPath: activeSessionPath,
                sessionRevision,
            });
            return await completion;
        },
        [activeSessionPath, cancelPendingReveals, sessionRevision]
    );
    const onRevealTurnComplete = useCallback((request: { turnId: string; requestId: number }) => {
        revealResolversRef.current.get(request.requestId)?.finish(true);
    }, []);
    useLayoutEffect(() => {
        cancelPendingReveals();
        setRevealTurnRequest(undefined);
    }, [activeSessionPath, cancelPendingReveals, sessionRevision]);
    useEffect(() => () => cancelPendingReveals(false), [cancelPendingReveals]);
    useEffect(() => {
        if (!userNotification) {
            return;
        }
        const timeout = window.setTimeout(() => setUserNotification(undefined), 4_000);
        return () => window.clearTimeout(timeout);
    }, [userNotification]);
    const onHostStateChange = useCallback(
        (next: AgentHostState) => {
            const previous = hostStateRef.current;
            const nextSessionPath = next.sessionPath ?? activeSessionPath;
            const nextSessionRevision = next.sessionRevision ?? sessionRevision;
            const sameScope =
                previous.sessionPath === nextSessionPath && previous.sessionRevision === nextSessionRevision;
            const scopeFallback = sameScope
                ? previous
                : makeEmptyHostState(nextSessionPath, nextSessionRevision, contextReferencesEnabled);
            const normalized: AgentHostState = {
                ...next,
                sessionPath: nextSessionPath,
                sessionRevision: nextSessionRevision,
                commands: next.commands ?? scopeFallback.commands,
                context: next.context ?? scopeFallback.context,
                rewindState: next.rewindState ?? EmptyRewindState,
            };
            hostStateRef.current = normalized;
            setReceivedHostState(normalized);
            if (!normalized.errorMessage) {
                setDismissedHostError(undefined);
            }
            if (
                (previous.status !== "streaming" && normalized.status === "streaming") ||
                (previous.status === "error" && normalized.status !== "error")
            ) {
                onUserError("");
            }
        },
        [activeSessionPath, contextReferencesEnabled, onUserError, sessionRevision]
    );
    const onSelectionChange = useCallback(
        (next: AgentSelection) => {
            model.selectModel({
                provider: next.provider,
                model: next.model,
                reasoning: next.reasoning ?? "",
            });
        },
        [model]
    );
    const onSessionChange = useCallback(
        (meta: AgentSessionMeta | undefined) => {
            model.selectSession(meta);
        },
        [model]
    );
    const onAgentSubmit = useCallback(
        (text: string, images?: string[]) => {
            if (!text && (images?.length ?? 0) === 0) return false;
            if (hostStateRef.current.rewindState.frozen && !isAgentSlashCommandReadOnly(text)) {
                onUserError("Workspace recovery must finish before sending another prompt.");
                return false;
            }
            const api = agentApiRef.current;
            if (!api) {
                onUserError("Agent is still starting. Try again in a moment.");
                return false;
            }
            const previousUserError = userErrorMessageRef.current;
            const previousWriteGeneration = userErrorWriteGenerationRef.current;
            userErrorMessageRef.current = "";
            setUserErrorMessage("");
            const accepted = api.submit(text, images);
            if (!accepted && userErrorWriteGenerationRef.current === previousWriteGeneration) {
                userErrorMessageRef.current = previousUserError;
                setUserErrorMessage(previousUserError);
            }
            return accepted;
        },
        [onUserError]
    );
    const contextTargetMatchesSession = hostState.context.targetSessionPath === agentStateValue.activeSession?.path;
    const contextHydrating = !!agentStateValue.activeSession?.path && !contextTargetMatchesSession;
    const contextSendGate = contextSendDisabledReason(
        contextReferencesEnabled ? hostState.context : { ...hostState.context, enabled: false }
    );
    const contextSendGuidance = contextHydrating
        ? "Context for the selected session is loading. Send will be available after hydration finishes."
        : contextSendGate
          ? agentContextSendGuidance(contextSendGate)
          : undefined;
    const assistantRuntime = useCrestAssistantRuntime({
        turns: agentTurns,
        status: hostState.status,
        submit: onAgentSubmit,
        abort: () => agentApiRef.current?.abort(),
        isSendDisabled: contextHydrating || contextSendGate != null,
    });
    const contextUsage = useMemo(() => getLatestAgentContextUsage(agentTurns), [agentTurns]);
    const contextIdentity = useMemo(
        () => ({
            targetSessionPath: hostState.context.targetSessionPath,
            targetGeneration: hostState.context.targetGeneration,
        }),
        [hostState.context.targetGeneration, hostState.context.targetSessionPath]
    );
    const requireCurrentContextApi = useCallback((): AgentChatHostApi => {
        if (
            hostStateRef.current.context.targetSessionPath !== contextIdentity.targetSessionPath ||
            hostStateRef.current.context.targetGeneration !== contextIdentity.targetGeneration
        ) {
            throw new Error("This context control is no longer current.");
        }
        const api = agentApiRef.current;
        if (!api) {
            throw new Error("Agent is still starting. Try again in a moment.");
        }
        return api;
    }, [contextIdentity]);
    const rewindController = useAgentRewind({
        client,
        sessionMetadata: agentStateValue.activeSession,
        sessionRevision,
        rewindState: hostState.rewindState,
        onRevealTurn,
        onEditorText,
        onError: onUserError,
    });
    const recoveryFrozen = hostState.rewindState.frozen;
    const rewindPreview = rewindController.preview.result;
    const rewindDialogLocked = rewindController.busy;
    const rewindDialogReady = rewindController.preview.phase === "ready" && !!rewindPreview && !rewindDialogLocked;
    const rewindCanRevert =
        rewindDialogReady && rewindController.preview.operation === "rewind" && !rewindPreview.hardBlocked;
    const rewindCanRedo =
        rewindDialogReady &&
        rewindController.preview.operation === "redo" &&
        !rewindPreview.hardBlocked &&
        !rewindPreview.forceRequired;
    const rewindFileCount = rewindPreview?.fileCount ?? 0;
    const rewindFileLabel = `${rewindFileCount} ${rewindFileCount === 1 ? "file" : "files"}`;
    const rewindWarnings = (rewindPreview?.coverageWarnings ?? []).filter(
        (warning, index, allWarnings) => allWarnings.indexOf(warning) === index
    );

    useEffect(() => {
        setRewindSelectedPath(undefined);
    }, [operationScopeKey, rewindPreview]);

    useLayoutEffect(() => {
        recoveryEpochRef.current++;
        quotaCleanupEpochRef.current++;
        quotaDialogEpochRef.current++;
        quotaMaintenanceLeaseRef.current = undefined;
        consumedPurgeTokensRef.current.clear();
        setRecoveryUi({ open: false, phase: "idle" });
        setQuotaBusy(false);
        setQuotaUi({ open: false, phase: "idle", owners: [], staleOwnerIds: [] });
    }, [client, operationScopeKey]);

    useEffect(() => {
        const sessionMetadata = agentStateValue.activeSession;
        if (!recoveryFrozen || !sessionMetadata) {
            recoveryEpochRef.current++;
            setRecoveryUi({ open: false, phase: "idle" });
            return;
        }
        const scopeKey = operationScopeKey;
        const epoch = ++recoveryEpochRef.current;
        setRecoveryUi({ open: true, phase: "loading" });
        void client
            .getWorkspaceRecovery({ sessionMetadata })
            .then((recovery) => {
                if (epoch !== recoveryEpochRef.current || operationScopeRef.current !== scopeKey) {
                    return;
                }
                setRecoveryUi({ open: true, phase: "idle", recovery });
            })
            .catch((error) => {
                if (epoch !== recoveryEpochRef.current || operationScopeRef.current !== scopeKey) {
                    return;
                }
                setRecoveryUi({
                    open: true,
                    phase: "error",
                    errorMessage: uiErrorMessage(error),
                });
            });
    }, [agentStateValue.activeSession, client, operationScopeKey, recoveryFrozen]);

    const resolveRecovery = useCallback(
        async (action: AgentResolveWorkspaceRecoveryInput["action"]): Promise<void> => {
            const sessionMetadata = agentStateValue.activeSession;
            const recovery = recoveryUi.recovery;
            if (!sessionMetadata || !recovery || recoveryUi.phase === "resolving") {
                return;
            }
            const scopeKey = operationScopeKey;
            const epoch = ++recoveryEpochRef.current;
            setRecoveryUi((current) => ({ ...current, phase: "resolving", errorMessage: undefined }));
            try {
                await client.resolveWorkspaceRecovery({
                    sessionMetadata,
                    operationId: recovery.operationId,
                    action,
                });
                if (
                    epoch !== recoveryEpochRef.current ||
                    operationScopeRef.current !== scopeKey ||
                    !hostStateRef.current.rewindState.frozen
                ) {
                    return;
                }
                const refreshed = await client.getWorkspaceRecovery({ sessionMetadata });
                if (epoch !== recoveryEpochRef.current || operationScopeRef.current !== scopeKey) {
                    return;
                }
                setRecoveryUi({ open: true, phase: "idle", recovery: refreshed });
            } catch (error) {
                if (epoch !== recoveryEpochRef.current || operationScopeRef.current !== scopeKey) {
                    return;
                }
                let refreshed = recovery;
                try {
                    refreshed = (await client.getWorkspaceRecovery({ sessionMetadata })) ?? recovery;
                } catch {}
                if (epoch !== recoveryEpochRef.current || operationScopeRef.current !== scopeKey) {
                    return;
                }
                setRecoveryUi({
                    open: true,
                    phase: "error",
                    recovery: refreshed,
                    errorMessage: uiErrorMessage(error),
                });
            }
        },
        [agentStateValue.activeSession, client, operationScopeKey, recoveryUi.phase, recoveryUi.recovery]
    );

    const cleanupCheckpoints = useCallback(async (): Promise<void> => {
        if (operationScopeRef.current !== operationScopeKey) {
            return;
        }
        const sessionMetadata = agentStateValue.activeSession;
        if (!sessionMetadata || quotaMaintenanceLeaseRef.current || hostStateRef.current.rewindState.frozen) {
            return;
        }
        const scopeKey = operationScopeKey;
        const lease = { scopeKey, token: Symbol("checkpoint-cleanup") };
        quotaMaintenanceLeaseRef.current = lease;
        const epoch = ++quotaCleanupEpochRef.current;
        setQuotaBusy(true);
        try {
            await client.cleanupWorkspaceCheckpoints({ sessionMetadata });
        } catch (error) {
            if (epoch === quotaCleanupEpochRef.current && operationScopeRef.current === scopeKey) {
                onUserError(uiErrorMessage(error));
            }
        } finally {
            if (
                quotaMaintenanceLeaseRef.current === lease &&
                epoch === quotaCleanupEpochRef.current &&
                operationScopeRef.current === scopeKey
            ) {
                quotaMaintenanceLeaseRef.current = undefined;
                setQuotaBusy(false);
            }
        }
    }, [agentStateValue.activeSession, client, onUserError, operationScopeKey]);

    const loadCheckpointOwners = useCallback(async (): Promise<void> => {
        if (operationScopeRef.current !== operationScopeKey) {
            return;
        }
        const sessionMetadata = agentStateValue.activeSession;
        if (!sessionMetadata || hostStateRef.current.rewindState.frozen || quotaMaintenanceLeaseRef.current) {
            return;
        }
        const scopeKey = operationScopeKey;
        const lease = { scopeKey, token: Symbol("checkpoint-owner-refresh") };
        quotaMaintenanceLeaseRef.current = lease;
        const epoch = ++quotaDialogEpochRef.current;
        setQuotaBusy(true);
        setQuotaUi((current) => ({
            ...current,
            open: true,
            phase: "loading",
            errorMessage: undefined,
        }));
        try {
            const result = await client.listCheckpointStorageOwners({ sessionMetadata });
            if (epoch !== quotaDialogEpochRef.current || operationScopeRef.current !== scopeKey) {
                return;
            }
            consumedPurgeTokensRef.current.clear();
            setQuotaUi({ open: true, phase: "ready", owners: result.trashOwners, staleOwnerIds: [] });
        } catch (error) {
            if (epoch !== quotaDialogEpochRef.current || operationScopeRef.current !== scopeKey) {
                return;
            }
            setQuotaUi((current) => ({
                ...current,
                open: true,
                phase: "error",
                errorMessage: uiErrorMessage(error),
            }));
        } finally {
            if (
                quotaMaintenanceLeaseRef.current === lease &&
                epoch === quotaDialogEpochRef.current &&
                operationScopeRef.current === scopeKey
            ) {
                quotaMaintenanceLeaseRef.current = undefined;
                setQuotaBusy(false);
            }
        }
    }, [agentStateValue.activeSession, client, operationScopeKey]);

    const purgeCheckpointOwner = useCallback(
        async (request: CheckpointPurgeRequest): Promise<void> => {
            if (
                operationScopeRef.current !== operationScopeKey ||
                consumedPurgeTokensRef.current.has(request.confirmationToken) ||
                quotaMaintenanceLeaseRef.current
            ) {
                return;
            }
            const sessionMetadata = agentStateValue.activeSession;
            if (!sessionMetadata || hostStateRef.current.rewindState.frozen) {
                return;
            }
            const scopeKey = operationScopeKey;
            const lease = { scopeKey, token: Symbol("checkpoint-owner-purge") };
            quotaMaintenanceLeaseRef.current = lease;
            const epoch = ++quotaDialogEpochRef.current;
            consumedPurgeTokensRef.current.add(request.confirmationToken);
            setQuotaBusy(true);
            setQuotaUi((current) => ({ ...current, phase: "purging", errorMessage: undefined }));
            try {
                let errorMessage: string | undefined;
                try {
                    await client.purgeTrashedSession({
                        sessionMetadata,
                        trashedSessionId: request.trashedSessionId,
                        confirmationToken: request.confirmationToken,
                    });
                } catch (error) {
                    errorMessage = uiErrorMessage(error);
                }
                if (epoch !== quotaDialogEpochRef.current || operationScopeRef.current !== scopeKey) {
                    return;
                }
                try {
                    const result = await client.listCheckpointStorageOwners({ sessionMetadata });
                    if (epoch !== quotaDialogEpochRef.current || operationScopeRef.current !== scopeKey) {
                        return;
                    }
                    consumedPurgeTokensRef.current.clear();
                    setQuotaUi({
                        open: true,
                        phase: errorMessage ? "error" : "ready",
                        owners: result.trashOwners,
                        staleOwnerIds: [],
                        errorMessage,
                    });
                } catch (refreshError) {
                    if (epoch !== quotaDialogEpochRef.current || operationScopeRef.current !== scopeKey) {
                        return;
                    }
                    const refreshErrorMessage = uiErrorMessage(refreshError);
                    setQuotaUi((current) => ({
                        ...current,
                        open: true,
                        phase: "error",
                        staleOwnerIds: current.staleOwnerIds.includes(request.trashedSessionId)
                            ? current.staleOwnerIds
                            : [...current.staleOwnerIds, request.trashedSessionId],
                        errorMessage: errorMessage
                            ? `${errorMessage} Storage diagnostics refresh also failed: ${refreshErrorMessage}`
                            : refreshErrorMessage,
                    }));
                }
            } finally {
                if (
                    quotaMaintenanceLeaseRef.current === lease &&
                    epoch === quotaDialogEpochRef.current &&
                    operationScopeRef.current === scopeKey
                ) {
                    quotaMaintenanceLeaseRef.current = undefined;
                    setQuotaBusy(false);
                }
            }
        },
        [agentStateValue.activeSession, client, operationScopeKey]
    );
    const closeCheckpointOwners = useCallback((): void => {
        if (operationScopeRef.current !== operationScopeKey || quotaMaintenanceLeaseRef.current) {
            return;
        }
        setQuotaUi((current) => ({ ...current, open: false }));
    }, [operationScopeKey]);

    return (
        <section className="h-full w-full" data-testid="agent-content">
            <AgentChatHost
                runtimeClient={client}
                sessionMetadata={agentStateValue.activeSession}
                sessionRevision={sessionRevision}
                onSessionChange={onSessionChange}
                modelSelection={
                    resolved.resolvedAIConfig
                        ? {
                              provider: resolved.resolvedAIConfig.provider,
                              model: resolved.resolvedAIConfig.model,
                              reasoning: resolved.resolvedAIConfig.reasoning,
                              token: resolved.resolvedAIConfig.token,
                              tokenSecretName: resolved.resolvedAIConfig.tokensecretname,
                          }
                        : activeSelection
                          ? {
                                provider: activeSelection.provider,
                                model: activeSelection.model,
                                reasoning: activeSelection.reasoning,
                            }
                          : undefined
                }
                executionContext={{ ...executionContext, sessionPath: agentStateValue.activeSession?.path }}
                selectionError={resolved.aiConfigError}
                onReady={(api) => {
                    agentApiRef.current = api;
                }}
                onTurnsChange={setAgentTurns}
                onStateChange={onHostStateChange}
                onUserError={onUserError}
                onCommandResult={(result) =>
                    setAttachedPanelState({
                        commandResults: [result],
                        selectorRequest: null,
                        modelPickerOpen: false,
                    })
                }
                onOpenModelPicker={() =>
                    setAttachedPanelState({ commandResults: [], selectorRequest: null, modelPickerOpen: true })
                }
                onSelectorRequest={(request) =>
                    setAttachedPanelState({ commandResults: [], selectorRequest: request, modelPickerOpen: false })
                }
                onRewindRequest={rewindController.openSelector}
                onRedoRequest={rewindController.openRedo}
                onRestoreComposerText={enqueueComposerText}
                contextReferencesEnabled={contextReferencesEnabled}
            />
            <div className="flex h-full min-h-0 flex-col">
                <AssistantRuntimeProvider runtime={assistantRuntime}>
                    <ComposerTextRestore
                        request={agentRestoredTextRequest}
                        sessionPath={activeSessionPath}
                        sessionRevision={sessionRevision}
                    />
                    <Thread
                        modelLabel={modelDisplayLabel}
                        onOpenModelPicker={() =>
                            setAttachedPanelState({ commandResults: [], selectorRequest: null, modelPickerOpen: true })
                        }
                        modelContextWindow={resolved.resolvedAIConfig?.contextwindow}
                        contextUsage={contextUsage}
                        workspaceDir={executionContext.workspaceDir}
                        onOpenFile={onOpenFile}
                        composerAnchorRef={composerAnchorRef}
                        revealTurnRequest={currentRevealTurnRequest}
                        onRevealTurnComplete={onRevealTurnComplete}
                        rewindableTurnIds={rewindController.rewindableTurnIds}
                        rewindBusy={rewindController.busy}
                        onRevertTurn={rewindController.openRewind}
                        hideScrollToBottom={
                            attachedPanelState.commandResults.length > 0 ||
                            attachedPanelState.selectorRequest != null ||
                            attachedPanelState.modelPickerOpen ||
                            hostState.queuedMessages.length > 0
                        }
                        beforeComposer={
                            <>
                                {recoveryFrozen ? (
                                    <section
                                        className="flex items-center gap-3 rounded-2xl border border-red-400/30 bg-red-500/10 px-3 py-2.5 text-sm"
                                        role="status"
                                    >
                                        <div className="min-w-0 flex-1">
                                            <p className="font-medium text-red-200">Workspace recovery required</p>
                                            <p className="text-xs text-red-200/75">
                                                Agent writes are frozen. Read-only conversation tools remain available.
                                            </p>
                                        </div>
                                        <button
                                            className="cursor-pointer rounded-lg border border-red-300/30 px-2.5 py-1 text-xs"
                                            onClick={() => setRecoveryUi((current) => ({ ...current, open: true }))}
                                            type="button"
                                        >
                                            Review recovery
                                        </button>
                                    </section>
                                ) : null}
                                <CheckpointQuotaBanner
                                    quota={hostState.rewindState.quota}
                                    busy={quotaBusy || hostState.rewindState.busy || recoveryFrozen}
                                    mutationsDisabled={recoveryFrozen}
                                    onCleanup={cleanupCheckpoints}
                                    onManage={loadCheckpointOwners}
                                />
                                {hostState.rewindState.redo ? (
                                    <RedoDock
                                        redo={hostState.rewindState.redo}
                                        busy={rewindController.busy}
                                        onRedo={rewindController.openRedo}
                                    />
                                ) : null}
                                <RewindSelector
                                    open={rewindController.selector.open}
                                    points={rewindController.selector.points}
                                    loading={rewindController.selector.phase === "loading"}
                                    errorMessage={rewindController.selector.errorMessage}
                                    onSelect={rewindController.selectRewindPoint}
                                    onClose={rewindController.closeSelector}
                                />
                                {contextTargetMatchesSession &&
                                (hostState.context.drafts.length > 0 || hostState.contextSendRecovery) ? (
                                    <ContextReferenceBar
                                        drafts={hostState.context.drafts}
                                        recovery={
                                            hostState.contextSendRecovery
                                                ? { errorMessage: hostState.contextSendRecovery.errorMessage }
                                                : undefined
                                        }
                                        onSummarizeDraft={(draftId) =>
                                            requireCurrentContextApi().summarizeContextDraft(draftId)
                                        }
                                        onDiscardDraft={(draftId) =>
                                            requireCurrentContextApi().discardContextDraft(draftId)
                                        }
                                        onRetrySend={() => requireCurrentContextApi().retryContextSend()}
                                        readOnly={!contextReferencesEnabled || !hostState.context.enabled}
                                        operatorMaxTokens={contextReferenceUiConfig.maxTokens}
                                    />
                                ) : null}
                                {contextSendGuidance ? (
                                    <p
                                        className="rounded-lg border border-border/60 bg-background/60 px-3 py-2 text-xs text-muted-foreground"
                                        role="status"
                                    >
                                        {contextSendGuidance}
                                    </p>
                                ) : null}
                                {agentStateValue.activeSession
                                    ? hostState.commands.map((snapshot) => (
                                          <AgentCommandCard
                                              client={client}
                                              key={snapshot.commandId}
                                              session={agentStateValue.activeSession}
                                              snapshot={snapshot}
                                          />
                                      ))
                                    : null}
                                <AgentCommandResultList
                                    results={attachedPanelState.commandResults}
                                    onDismiss={(index) =>
                                        setAttachedPanelState((prev) => ({
                                            ...prev,
                                            commandResults: prev.commandResults.filter((_, i) => i !== index),
                                        }))
                                    }
                                />
                                <SessionSelector
                                    anchorRef={composerAnchorRef}
                                    request={attachedPanelState.selectorRequest}
                                    referencesEnabled={
                                        contextReferencesEnabled &&
                                        hostState.context.enabled &&
                                        contextTargetMatchesSession
                                    }
                                    onClose={() =>
                                        setAttachedPanelState((prev) => ({ ...prev, selectorRequest: null }))
                                    }
                                    onUserMessage={onUserMessage}
                                    onEditorText={onEditorText}
                                />
                                <ModelPickerInline
                                    open={attachedPanelState.modelPickerOpen}
                                    onOpenChange={(open) =>
                                        setAttachedPanelState((prev) => ({
                                            commandResults: open ? [] : prev.commandResults,
                                            selectorRequest: open ? null : prev.selectorRequest,
                                            modelPickerOpen: open,
                                        }))
                                    }
                                    selection={activeSelection}
                                    onSelectionChange={onSelectionChange}
                                    userConfig={userConfigState.config}
                                    userConfigStatus={userConfigState.status}
                                    userConfigError={userConfigState.error}
                                    catalog={CATALOG}
                                    onOpenConfigFile={() => {}}
                                    anchorRef={composerAnchorRef}
                                />
                                <AgentInlineNotification
                                    message={userNotification?.message}
                                    onDismiss={() => setUserNotification(undefined)}
                                />
                                <AgentInlineError
                                    message={visibleError?.message}
                                    onDismiss={() => {
                                        if (visibleError?.source === "host") {
                                            setDismissedHostError(hostState.errorMessage);
                                            return;
                                        }
                                        if (visibleError?.source === "model") {
                                            setDismissedModelError(modelErrorMessage);
                                            return;
                                        }
                                        onUserError("");
                                    }}
                                />
                                <QueuedMessagesPanel messages={hostState.queuedMessages} />
                            </>
                        }
                    />
                    <DiffReviewDialog
                        open={rewindController.preview.open}
                        title={rewindController.preview.operation === "rewind" ? "Revert changes?" : "Redo changes?"}
                        description="Red will be removed · Green will be restored"
                        files={rewindPreview?.files ?? []}
                        selectedPath={rewindSelectedPath}
                        loading={rewindController.preview.phase === "loading"}
                        errorMessage={rewindController.preview.errorMessage}
                        warnings={rewindWarnings}
                        locked={rewindDialogLocked}
                        emptyMessage="No workspace files will change."
                        footer={
                            <>
                                <Button
                                    className="cursor-pointer"
                                    variant="outline"
                                    disabled={rewindDialogLocked}
                                    onClick={rewindController.cancelPreview}
                                >
                                    Cancel
                                </Button>
                                {rewindCanRevert && rewindPreview.forceRequired && (
                                    <Button
                                        className="cursor-pointer"
                                        variant="destructive"
                                        onClick={() => void rewindController.confirmPreview("force-drift")}
                                    >
                                        Force revert
                                    </Button>
                                )}
                                {rewindCanRevert && !rewindPreview.forceRequired && (
                                    <Button
                                        className="cursor-pointer"
                                        onClick={() => void rewindController.confirmPreview("normal")}
                                    >
                                        Revert {rewindFileLabel}
                                    </Button>
                                )}
                                {rewindCanRedo && (
                                    <Button
                                        className="cursor-pointer"
                                        onClick={() => void rewindController.confirmPreview("normal")}
                                    >
                                        Redo {rewindFileLabel}
                                    </Button>
                                )}
                            </>
                        }
                        onSelectedPathChange={setRewindSelectedPath}
                        onOpenChange={(open) => {
                            if (!open) rewindController.cancelPreview();
                        }}
                    />
                    <RecoveryDialog
                        open={recoveryFrozen && recoveryUi.open}
                        recovery={recoveryUi.recovery}
                        busy={recoveryUi.phase === "loading" || recoveryUi.phase === "resolving"}
                        errorMessage={recoveryUi.errorMessage}
                        onAction={resolveRecovery}
                        onClose={() => setRecoveryUi((current) => ({ ...current, open: false }))}
                    />
                    <CheckpointQuotaDialog
                        open={quotaUi.open}
                        owners={quotaUi.owners}
                        phase={quotaUi.phase}
                        errorMessage={quotaUi.errorMessage}
                        maintenanceBusy={quotaBusy}
                        mutationsDisabled={recoveryFrozen}
                        onClose={closeCheckpointOwners}
                        onPurge={purgeCheckpointOwner}
                        onRefresh={loadCheckpointOwners}
                        staleOwnerIds={quotaUi.staleOwnerIds}
                    />
                </AssistantRuntimeProvider>
            </div>
        </section>
    );
}
