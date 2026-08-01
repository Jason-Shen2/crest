// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentRuntimeClient } from "@/app/agent/agent-runtime-client";
import type { PiTurn } from "@/app/store/use-pi-chat";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface UseAgentTurnChangesOptions {
    client: AgentRuntimeClient;
    sessionMetadata?: AgentSessionMeta;
    sessionRevision: number;
    rewindState: AgentRewindSessionStateView;
    turns: PiTurn[];
    running: boolean;
    onError(message: string): void;
}

export interface AgentTurnChangesCardState {
    summary: AgentTurnChangeSummaryView;
    action: "undo" | "redo";
    disabled: boolean;
}

export interface AgentTurnChangesDialogState {
    open: boolean;
    kind: "review" | "undo" | "redo";
    turnId?: string;
    phase: "loading" | "ready" | "applying" | "error";
    files: AgentRewindFileRowView[];
    selectedPath?: string;
    preview?: AgentTurnMutationPreviewResult;
    errorMessage?: string;
}

export interface AgentTurnChangesController {
    cards: ReadonlyMap<string, AgentTurnChangesCardState>;
    dialog: AgentTurnChangesDialogState;
    awaitingAuthoritativeAck: boolean;
    controlsDisabled: boolean;
    openReview(turnId: string): Promise<void>;
    openMutation(turnId: string): Promise<void>;
    confirmMutation(mode: "normal" | "force-drift"): Promise<void>;
    closeDialog(): void;
    selectDialogPath(path: string): void;
}

interface RequestIdentity {
    sessionMetadata: AgentSessionMeta;
    sessionPath: string;
    sessionRevision: number;
    semanticLeafId: string | null;
}

interface TurnConfirmation {
    identity: RequestIdentity;
    turnId: string;
    action: "undo" | "redo";
    undoOperationId?: string;
    token: string;
}

interface PendingAck {
    identity: RequestIdentity;
    operationEpoch: number;
    turnId: string;
    expectedAction: "undo" | "redo";
    resultReceived: boolean;
}

const SummaryRetryLimit = 3;
const SummaryRetryDelayMs = 50;

const ClosedDialog: AgentTurnChangesDialogState = {
    open: false,
    kind: "review",
    phase: "loading",
    files: [],
};

function messageFromError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sameIdentity(left: RequestIdentity | undefined, right: RequestIdentity | undefined): boolean {
    return (
        !!left &&
        !!right &&
        left.sessionPath === right.sessionPath &&
        left.sessionRevision === right.sessionRevision &&
        left.semanticLeafId === right.semanticLeafId
    );
}

function sameSessionIdentity(left: RequestIdentity | undefined, right: RequestIdentity | undefined): boolean {
    return (
        !!left &&
        !!right &&
        left.sessionPath === right.sessionPath &&
        left.sessionMetadata.id === right.sessionMetadata.id &&
        left.sessionRevision === right.sessionRevision
    );
}

function cacheKey(identity: RequestIdentity, turnId: string): string {
    return `${identity.sessionPath}\u0000${identity.semanticLeafId ?? ""}\u0000${turnId}`;
}

export function useAgentTurnChanges(options: UseAgentTurnChangesOptions): AgentTurnChangesController {
    const [summaryCache, setSummaryCache] = useState<ReadonlyMap<string, AgentTurnChangeSummaryView | null>>(new Map());
    const [dialog, setDialog] = useState<AgentTurnChangesDialogState>(ClosedDialog);
    const [awaitingAuthoritativeAck, setAwaitingAuthoritativeAck] = useState(false);
    const [summaryRetryRevision, setSummaryRetryRevision] = useState(0);
    const requestedSummariesRef = useRef(new Set<string>());
    const summaryAttemptsRef = useRef(new Map<string, number>());
    const summaryRetryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const identityEpochRef = useRef(0);
    const dialogEpochRef = useRef(0);
    const mutationEpochRef = useRef(0);
    const confirmationRef = useRef<TurnConfirmation | undefined>(undefined);
    const pendingAckRef = useRef<PendingAck | undefined>(undefined);
    const applyInFlightRef = useRef(false);
    const mountedRef = useRef(false);
    const optionsRef = useRef(options);
    optionsRef.current = options;

    const currentIdentity = options.sessionMetadata?.path
        ? {
              sessionMetadata: options.sessionMetadata,
              sessionPath: options.sessionMetadata.path,
              sessionRevision: options.sessionRevision,
              semanticLeafId: options.rewindState.semanticLeafId,
          }
        : undefined;
    const identityRef = useRef<RequestIdentity | undefined>(undefined);
    identityRef.current = currentIdentity;
    const mutationScopeKey = `${currentIdentity?.sessionPath ?? ""}\u0000${currentIdentity?.sessionMetadata.id ?? ""}\u0000${currentIdentity?.sessionRevision ?? 0}`;
    const readScopeKey = `${mutationScopeKey}\u0000${currentIdentity?.semanticLeafId ?? ""}`;

    const authorityByTurn = useMemo(
        () => new Map(options.rewindState.turnChanges.map((authority) => [authority.turnId, authority])),
        [options.rewindState.turnChanges]
    );
    const doneTurnIds = useMemo(
        () => new Set(options.turns.filter((turn) => turn.status === "done").map((turn) => turn.turnId)),
        [options.turns]
    );

    useLayoutEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            identityEpochRef.current++;
            dialogEpochRef.current++;
            mutationEpochRef.current++;
            for (const timer of summaryRetryTimersRef.current.values()) clearTimeout(timer);
            summaryRetryTimersRef.current.clear();
            confirmationRef.current = undefined;
            pendingAckRef.current = undefined;
            applyInFlightRef.current = false;
        };
    }, []);

    useLayoutEffect(() => {
        mutationEpochRef.current++;
        dialogEpochRef.current++;
        confirmationRef.current = undefined;
        pendingAckRef.current = undefined;
        applyInFlightRef.current = false;
        setAwaitingAuthoritativeAck(false);
        setDialog(ClosedDialog);
    }, [mutationScopeKey]);

    useLayoutEffect(() => {
        identityEpochRef.current++;
        for (const timer of summaryRetryTimersRef.current.values()) clearTimeout(timer);
        summaryRetryTimersRef.current.clear();
        requestedSummariesRef.current = new Set();
        summaryAttemptsRef.current = new Map();
        setSummaryCache(new Map());
        if (applyInFlightRef.current || pendingAckRef.current) return;
        dialogEpochRef.current++;
        confirmationRef.current = undefined;
        setDialog(ClosedDialog);
    }, [readScopeKey]);

    useEffect(() => {
        const identity = identityRef.current;
        if (!identity || !options.rewindState.enabled) return;
        const epoch = identityEpochRef.current;
        for (const authority of options.rewindState.turnChanges) {
            if (!doneTurnIds.has(authority.turnId)) continue;
            const key = cacheKey(identity, authority.turnId);
            if (requestedSummariesRef.current.has(key)) continue;
            requestedSummariesRef.current.add(key);
            void options.client
                .getTurnChangeSummary({
                    sessionMetadata: identity.sessionMetadata,
                    expectedSemanticLeafId: identity.semanticLeafId,
                    turnId: authority.turnId,
                })
                .then((summary) => {
                    if (
                        !mountedRef.current ||
                        epoch !== identityEpochRef.current ||
                        !sameIdentity(identity, identityRef.current) ||
                        summary.turnId !== authority.turnId ||
                        summary.semanticLeafId !== identity.semanticLeafId
                    ) {
                        return;
                    }
                    setSummaryCache((current) => {
                        const next = new Map(current);
                        next.set(key, summary.fileCount > 0 && summary.files.length > 0 ? summary : null);
                        return next;
                    });
                    summaryAttemptsRef.current.delete(key);
                })
                .catch((error) => {
                    if (
                        !mountedRef.current ||
                        epoch !== identityEpochRef.current ||
                        !sameIdentity(identity, identityRef.current)
                    ) {
                        return;
                    }
                    const attempt = (summaryAttemptsRef.current.get(key) ?? 0) + 1;
                    summaryAttemptsRef.current.set(key, attempt);
                    if (attempt < SummaryRetryLimit) {
                        const timer = setTimeout(() => {
                            summaryRetryTimersRef.current.delete(key);
                            if (
                                !mountedRef.current ||
                                epoch !== identityEpochRef.current ||
                                !sameIdentity(identity, identityRef.current)
                            ) {
                                return;
                            }
                            requestedSummariesRef.current.delete(key);
                            setSummaryRetryRevision((current) => current + 1);
                        }, SummaryRetryDelayMs);
                        summaryRetryTimersRef.current.set(key, timer);
                        return;
                    }
                    setSummaryCache((current) => new Map(current).set(key, null));
                    optionsRef.current.onError(messageFromError(error));
                });
        }
    }, [
        doneTurnIds,
        options.client,
        options.rewindState.enabled,
        options.rewindState.turnChanges,
        summaryRetryRevision,
    ]);

    useLayoutEffect(() => {
        const pending = pendingAckRef.current;
        if (
            !pending ||
            !pending.resultReceived ||
            pending.operationEpoch !== mutationEpochRef.current ||
            !sameSessionIdentity(pending.identity, identityRef.current)
        ) {
            return;
        }
        const authority = authorityByTurn.get(pending.turnId);
        if (authority?.action !== pending.expectedAction) return;
        pendingAckRef.current = undefined;
        setAwaitingAuthoritativeAck(false);
        setDialog(ClosedDialog);
    }, [authorityByTurn]);

    const globallyDisabled =
        options.running ||
        options.rewindState.busy ||
        options.rewindState.frozen ||
        awaitingAuthoritativeAck ||
        applyInFlightRef.current;

    const cards = useMemo(() => {
        const next = new Map<string, AgentTurnChangesCardState>();
        const identity = currentIdentity;
        if (!identity || !options.rewindState.enabled) return next;
        for (const [turnId, authority] of authorityByTurn) {
            if (!doneTurnIds.has(turnId)) continue;
            const summary = summaryCache.get(cacheKey(identity, turnId));
            if (!summary) continue;
            next.set(turnId, { summary, action: authority.action, disabled: globallyDisabled });
        }
        return next;
    }, [authorityByTurn, currentIdentity, doneTurnIds, globallyDisabled, options.rewindState.enabled, summaryCache]);

    const beginDialogRequest = useCallback((kind: AgentTurnChangesDialogState["kind"], turnId: string) => {
        const epoch = ++dialogEpochRef.current;
        confirmationRef.current = undefined;
        setDialog({ open: true, kind, turnId, phase: "loading", files: [] });
        return epoch;
    }, []);

    const requestIsCurrent = useCallback((identity: RequestIdentity, epoch: number): boolean => {
        return mountedRef.current && epoch === dialogEpochRef.current && sameIdentity(identity, identityRef.current);
    }, []);

    const mutationIsCurrent = useCallback((identity: RequestIdentity, operationEpoch: number): boolean => {
        return (
            mountedRef.current &&
            operationEpoch === mutationEpochRef.current &&
            sameSessionIdentity(identity, identityRef.current)
        );
    }, []);

    const openReview = useCallback(
        async (turnId: string): Promise<void> => {
            const identity = identityRef.current;
            if (!identity || globallyDisabled || !cards.has(turnId)) return;
            const epoch = beginDialogRequest("review", turnId);
            try {
                const result = await optionsRef.current.client.reviewTurnChanges({
                    sessionMetadata: identity.sessionMetadata,
                    expectedSemanticLeafId: identity.semanticLeafId,
                    turnId,
                });
                if (
                    !requestIsCurrent(identity, epoch) ||
                    result.turnId !== turnId ||
                    result.semanticLeafId !== identity.semanticLeafId
                ) {
                    return;
                }
                setDialog({
                    open: true,
                    kind: "review",
                    turnId,
                    phase: "ready",
                    files: result.files,
                    selectedPath: result.files[0]?.path,
                });
            } catch (error) {
                if (!requestIsCurrent(identity, epoch)) return;
                const errorMessage = messageFromError(error);
                setDialog({ open: true, kind: "review", turnId, phase: "error", files: [], errorMessage });
                optionsRef.current.onError(errorMessage);
            }
        },
        [beginDialogRequest, cards, globallyDisabled, requestIsCurrent]
    );

    const openMutation = useCallback(
        async (turnId: string): Promise<void> => {
            const identity = identityRef.current;
            const authority = authorityByTurn.get(turnId);
            if (!identity || globallyDisabled || !cards.has(turnId) || !authority) return;
            const action = authority.action;
            const epoch = beginDialogRequest(action, turnId);
            try {
                const input: AgentPreviewTurnMutationInput = {
                    sessionMetadata: identity.sessionMetadata,
                    expectedSemanticLeafId: identity.semanticLeafId,
                    turnId,
                    ...(action === "redo" ? { undoOperationId: authority.undoOperationId } : {}),
                };
                const result =
                    action === "undo"
                        ? await optionsRef.current.client.previewTurnUndo(input)
                        : await optionsRef.current.client.previewTurnRedo(input);
                if (
                    !requestIsCurrent(identity, epoch) ||
                    result.semanticLeafId !== identity.semanticLeafId ||
                    result.target.sourceTurnId !== turnId
                ) {
                    return;
                }
                if (result.confirmationToken) {
                    confirmationRef.current = {
                        identity,
                        turnId,
                        action,
                        undoOperationId: authority.undoOperationId,
                        token: result.confirmationToken,
                    };
                }
                setDialog({
                    open: true,
                    kind: action,
                    turnId,
                    phase: "ready",
                    files: result.files,
                    selectedPath: result.files[0]?.path,
                    preview: result,
                });
            } catch (error) {
                if (!requestIsCurrent(identity, epoch)) return;
                const errorMessage = messageFromError(error);
                setDialog({ open: true, kind: action, turnId, phase: "error", files: [], errorMessage });
                optionsRef.current.onError(errorMessage);
            }
        },
        [authorityByTurn, beginDialogRequest, cards, globallyDisabled, requestIsCurrent]
    );

    const confirmMutation = useCallback(
        async (mode: "normal" | "force-drift"): Promise<void> => {
            const confirmation = confirmationRef.current;
            if (
                !confirmation ||
                globallyDisabled ||
                applyInFlightRef.current ||
                !sameIdentity(confirmation.identity, identityRef.current) ||
                (confirmation.action === "redo" && mode === "force-drift")
            ) {
                return;
            }
            const operationEpoch = ++mutationEpochRef.current;
            applyInFlightRef.current = true;
            setAwaitingAuthoritativeAck(true);
            pendingAckRef.current = {
                identity: confirmation.identity,
                operationEpoch,
                turnId: confirmation.turnId,
                expectedAction: confirmation.action === "undo" ? "redo" : "undo",
                resultReceived: false,
            };
            confirmationRef.current = undefined;
            setDialog((current) => ({ ...current, phase: "applying", errorMessage: undefined }));
            const input: AgentApplyTurnMutationInput = {
                sessionMetadata: confirmation.identity.sessionMetadata,
                expectedSemanticLeafId: confirmation.identity.semanticLeafId,
                turnId: confirmation.turnId,
                ...(confirmation.action === "redo" ? { undoOperationId: confirmation.undoOperationId } : {}),
                mode,
                confirmationToken: confirmation.token,
            };
            try {
                if (confirmation.action === "undo") {
                    await optionsRef.current.client.applyTurnUndo(input);
                } else {
                    await optionsRef.current.client.applyTurnRedo(input);
                }
                if (!mutationIsCurrent(confirmation.identity, operationEpoch)) return;
                applyInFlightRef.current = false;
                const pending = pendingAckRef.current;
                if (pending) pending.resultReceived = true;
                const authority = new Map(
                    optionsRef.current.rewindState.turnChanges.map((item) => [item.turnId, item])
                ).get(confirmation.turnId);
                if (pending && authority?.action === pending.expectedAction) {
                    pendingAckRef.current = undefined;
                    setAwaitingAuthoritativeAck(false);
                    setDialog(ClosedDialog);
                    return;
                }
                setDialog((current) => ({ ...current, phase: "applying" }));
            } catch (error) {
                if (!mutationIsCurrent(confirmation.identity, operationEpoch)) return;
                applyInFlightRef.current = false;
                pendingAckRef.current = undefined;
                setAwaitingAuthoritativeAck(false);
                const errorMessage = messageFromError(error);
                setDialog((current) => ({ ...current, open: true, phase: "error", errorMessage }));
                optionsRef.current.onError(errorMessage);
            }
        },
        [globallyDisabled, mutationIsCurrent]
    );

    const closeDialog = useCallback(() => {
        if (applyInFlightRef.current || pendingAckRef.current) return;
        dialogEpochRef.current++;
        confirmationRef.current = undefined;
        setDialog(ClosedDialog);
    }, []);

    const selectDialogPath = useCallback((path: string) => {
        setDialog((current) => ({ ...current, selectedPath: path }));
    }, []);

    return {
        cards,
        dialog,
        awaitingAuthoritativeAck,
        controlsDisabled: globallyDisabled,
        openReview,
        openMutation,
        confirmMutation,
        closeDialog,
        selectDialogPath,
    };
}
