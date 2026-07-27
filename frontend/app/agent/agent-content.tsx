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
import type { PiAgentMessage, PiTurn } from "@/app/store/use-pi-chat";
import { ModelPickerInline } from "@/app/view/cmdblock/model-picker-popover";
import { SessionSelector } from "@/app/view/cmdblock/session-selector";
import type { WorkspaceAgentModel } from "@/app/workspace/workspace-agent-model";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    AgentChatHost,
    type AgentChatHostApi,
    type AgentHostState,
    type AgentInlineCommandResult,
    type AgentSelectorRequest,
} from "./agent-chat-host";
import { AgentCommandCard } from "./agent-command-card";
import { AgentCommandResultList } from "./agent-command-result";
import type { AgentRuntimeClient } from "./agent-runtime-client";
import {
    AssistantRuntimeProvider,
    ContextReferenceBar,
    Thread,
    useAui,
    useCrestAssistantRuntime,
} from "./assistant-ui";
import type { CrestContextUsage } from "./assistant-ui/context-display";

export interface AgentContentProps {
    model: WorkspaceAgentModel;
    client: AgentRuntimeClient;
    executionContext: AgentExecutionContext;
}

interface AgentAttachedPanelState {
    commandResults: AgentInlineCommandResult[];
    selectorRequest: AgentSelectorRequest | null;
    modelPickerOpen: boolean;
}

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

function ComposerTextRestore({ request }: { request?: { text: string; requestId: number } }) {
    const aui = useAui();
    useEffect(() => {
        if (!request) return;
        aui.composer().setText(request.text);
    }, [aui, request]);
    return null;
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

export function AgentContent({ model, client, executionContext }: AgentContentProps) {
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
    const [agentRestoredTextRequest, setAgentRestoredTextRequest] = useState<
        { text: string; requestId: number } | undefined
    >(undefined);
    const initialHostState: AgentHostState = {
        status: "idle",
        queuedMessages: [],
        commands: [],
        context: {
            ...createContextReferenceState(),
            enabled: contextReferencesEnabled,
        },
    };
    const [hostState, setHostState] = useState<AgentHostState>(initialHostState);
    const hostStateRef = useRef(initialHostState);
    const [dismissedHostError, setDismissedHostError] = useState<string>();
    const [dismissedModelError, setDismissedModelError] = useState<string>();
    const [userErrorMessage, setUserErrorMessage] = useState("");
    const [userNotificationMessage, setUserNotificationMessage] = useState("");
    const userErrorMessageRef = useRef("");
    const userErrorWriteGenerationRef = useRef(0);
    const [agentTurns, setAgentTurns] = useState<PiTurn[]>([]);
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
        setUserNotificationMessage(message);
    }, []);
    useEffect(() => {
        if (!userNotificationMessage) {
            return;
        }
        const timeout = window.setTimeout(() => setUserNotificationMessage(""), 4_000);
        return () => window.clearTimeout(timeout);
    }, [userNotificationMessage]);
    const onHostStateChange = useCallback(
        (next: AgentHostState) => {
            const previous = hostStateRef.current;
            const normalized: AgentHostState = {
                ...next,
                commands: next.commands ?? previous.commands,
                context: next.context ?? previous.context,
            };
            hostStateRef.current = normalized;
            setHostState(normalized);
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
        [onUserError]
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
    const contextTargetMatchesSession =
        hostState.context.targetSessionPath === agentStateValue.activeSession?.path;
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
                    setAttachedPanelState((prev) => ({
                        commandResults: [result],
                        selectorRequest: null,
                        modelPickerOpen: false,
                    }))
                }
                onOpenModelPicker={() =>
                    setAttachedPanelState({ commandResults: [], selectorRequest: null, modelPickerOpen: true })
                }
                onSelectorRequest={(request) =>
                    setAttachedPanelState({ commandResults: [], selectorRequest: request, modelPickerOpen: false })
                }
                contextReferencesEnabled={contextReferencesEnabled}
            />
            <div className="flex h-full min-h-0 flex-col">
                <AssistantRuntimeProvider runtime={assistantRuntime}>
                    <ComposerTextRestore request={agentRestoredTextRequest} />
                    <Thread
                        modelLabel={modelDisplayLabel}
                        onOpenModelPicker={() =>
                            setAttachedPanelState({ commandResults: [], selectorRequest: null, modelPickerOpen: true })
                        }
                        modelContextWindow={resolved.resolvedAIConfig?.contextwindow}
                        contextUsage={contextUsage}
                        composerAnchorRef={composerAnchorRef}
                        hideScrollToBottom={
                            attachedPanelState.commandResults.length > 0 ||
                            attachedPanelState.selectorRequest != null ||
                            attachedPanelState.modelPickerOpen ||
                            hostState.queuedMessages.length > 0
                        }
                        beforeComposer={
                            <>
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
                                    onEditorText={(text) =>
                                        setAgentRestoredTextRequest((prev) => ({
                                            text,
                                            requestId: (prev?.requestId ?? 0) + 1,
                                        }))
                                    }
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
                                    message={userNotificationMessage}
                                    onDismiss={() => setUserNotificationMessage("")}
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
                </AssistantRuntimeProvider>
            </div>
        </section>
    );
}
