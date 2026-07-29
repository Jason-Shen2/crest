// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { AgentRuntimeClient } from "@/app/agent/agent-runtime-client";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

export interface UseAgentRewindOptions {
    client: AgentRuntimeClient;
    sessionMetadata?: AgentSessionMeta;
    sessionRevision: number;
    rewindState: AgentRewindSessionStateView;
    onRevealTurn: (turnId: string) => Promise<void>;
    onEditorText: (text: string) => void;
    onError: (message: string) => void;
}

export interface AgentRewindSelectorState {
    open: boolean;
    phase: "idle" | "loading" | "ready" | "error";
    points: AgentRewindPointView[];
    errorMessage?: string;
}

export interface AgentRewindPreviewState {
    open: boolean;
    operation: "rewind" | "redo";
    phase: "loading" | "ready" | "applying" | "error";
    result?: AgentRewindPreviewResult;
    errorMessage?: string;
}

export interface AgentRewindController {
    selector: AgentRewindSelectorState;
    preview: AgentRewindPreviewState;
    busy: boolean;
    rewindableTurnIds: ReadonlySet<string>;
    openSelector(): Promise<void>;
    selectRewindPoint(turnId: string): Promise<void>;
    openRewind(turnId: string): Promise<void>;
    openRedo(): Promise<void>;
    closeSelector(): void;
    cancelPreview(): void;
    confirmPreview(mode: "normal" | "force-drift"): Promise<void>;
}

interface RewindRequestIdentity {
    sessionMetadata: AgentSessionMeta;
    sessionPath: string;
    sessionRevision: number;
    semanticLeafId: string | null;
}

interface RewindConfirmation {
    identity: RewindRequestIdentity;
    token: string;
    target: AgentRewindPreviewResult["target"];
}

interface RewindRequestGuard {
    identity: RewindRequestIdentity;
    lifetime: number;
    epoch: number;
}

interface RewindSelectorCapture {
    identity: RewindRequestIdentity;
    lifetime: number;
    epoch: number;
    semanticLeafId: string | null;
    displayLeafId: string | null;
    eligibleTurnIds: ReadonlySet<string>;
}

const IdleSelectorState: AgentRewindSelectorState = {
    open: false,
    phase: "idle",
    points: [],
};

const IdlePreviewState: AgentRewindPreviewState = {
    open: false,
    operation: "rewind",
    phase: "loading",
};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sameIdentity(left: RewindRequestIdentity | undefined, right: RewindRequestIdentity | undefined): boolean {
    return (
        !!left &&
        !!right &&
        left.sessionPath === right.sessionPath &&
        left.sessionRevision === right.sessionRevision &&
        left.semanticLeafId === right.semanticLeafId
    );
}

export function useAgentRewind(options: UseAgentRewindOptions): AgentRewindController {
    const [selector, setSelector] = useState<AgentRewindSelectorState>(IdleSelectorState);
    const [preview, setPreview] = useState<AgentRewindPreviewState>(IdlePreviewState);
    const confirmationRef = useRef<RewindConfirmation | undefined>(undefined);
    const selectorCaptureRef = useRef<RewindSelectorCapture | undefined>(undefined);
    const mountedRef = useRef(false);
    const lifetimeRef = useRef(0);
    const selectorEpochRef = useRef(0);
    const previewEpochRef = useRef(0);
    const applyEpochRef = useRef(0);
    const applyInFlightRef = useRef(false);
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
    const identityRef = useRef<RewindRequestIdentity | undefined>(undefined);
    identityRef.current = currentIdentity;
    const identityKey = `${currentIdentity?.sessionPath ?? ""}\u0000${currentIdentity?.sessionRevision ?? 0}\u0000${
        currentIdentity?.semanticLeafId ?? ""
    }`;

    const isCurrent = useCallback((guard: RewindRequestGuard, currentEpoch: number): boolean => {
        return (
            mountedRef.current &&
            guard.lifetime === lifetimeRef.current &&
            guard.epoch === currentEpoch &&
            sameIdentity(guard.identity, identityRef.current)
        );
    }, []);

    useLayoutEffect(() => {
        mountedRef.current = true;
        lifetimeRef.current++;
        return () => {
            mountedRef.current = false;
            lifetimeRef.current++;
            selectorEpochRef.current++;
            previewEpochRef.current++;
            applyEpochRef.current++;
            applyInFlightRef.current = false;
            confirmationRef.current = undefined;
            selectorCaptureRef.current = undefined;
        };
    }, []);

    useLayoutEffect(() => {
        lifetimeRef.current++;
        selectorEpochRef.current++;
        previewEpochRef.current++;
        applyEpochRef.current++;
        applyInFlightRef.current = false;
        confirmationRef.current = undefined;
        selectorCaptureRef.current = undefined;
        setSelector(IdleSelectorState);
        setPreview(IdlePreviewState);
    }, [identityKey]);

    const reportError = useCallback((message: string): void => {
        optionsRef.current.onError(message);
    }, []);

    const openSelector = useCallback(async (): Promise<void> => {
        if (!mountedRef.current) return;
        const epoch = ++selectorEpochRef.current;
        if (applyInFlightRef.current) return;
        const identity = identityRef.current;
        if (!identity) {
            const message = "No agent session is available for rewind.";
            setSelector({ open: true, phase: "error", points: [], errorMessage: message });
            reportError(message);
            return;
        }
        const guard = { identity, lifetime: lifetimeRef.current, epoch };
        const client = optionsRef.current.client;
        selectorCaptureRef.current = undefined;
        setSelector({ open: true, phase: "loading", points: [] });
        try {
            const result = await client.listRewindPoints({
                sessionMetadata: identity.sessionMetadata,
            });
            if (!isCurrent(guard, selectorEpochRef.current)) return;
            if (result.semanticLeafId !== identity.semanticLeafId) {
                const message = "Rewind history changed. Open the selector again.";
                setSelector({ open: true, phase: "error", points: [], errorMessage: message });
                return;
            }
            selectorCaptureRef.current = {
                identity,
                lifetime: guard.lifetime,
                epoch: guard.epoch,
                semanticLeafId: result.semanticLeafId,
                displayLeafId: result.displayLeafId,
                eligibleTurnIds: new Set(result.points.filter((point) => point.eligible).map((point) => point.turnId)),
            };
            setSelector({ open: true, phase: "ready", points: result.points });
        } catch (error) {
            if (!isCurrent(guard, selectorEpochRef.current)) return;
            selectorCaptureRef.current = undefined;
            const message = errorMessage(error);
            setSelector({ open: true, phase: "error", points: [], errorMessage: message });
            if (!isCurrent(guard, selectorEpochRef.current)) return;
            reportError(message);
        }
    }, [isCurrent, reportError]);

    const openPreview = useCallback(
        async (target: AgentRewindPreviewResult["target"]): Promise<void> => {
            if (!mountedRef.current) return;
            const epoch = ++previewEpochRef.current;
            if (applyInFlightRef.current) return;
            selectorEpochRef.current++;
            const identity = identityRef.current;
            const operation = target.kind;
            confirmationRef.current = undefined;
            selectorCaptureRef.current = undefined;
            setSelector(IdleSelectorState);
            if (!identity) {
                const message = "No agent session is available for rewind.";
                setPreview({ open: true, operation, phase: "error", errorMessage: message });
                reportError(message);
                return;
            }
            const guard = { identity, lifetime: lifetimeRef.current, epoch };
            const client = optionsRef.current.client;
            setPreview({ open: true, operation, phase: "loading" });
            try {
                const result = await client.previewRewind({
                    sessionMetadata: identity.sessionMetadata,
                    expectedSemanticLeafId: identity.semanticLeafId,
                    target,
                });
                if (!isCurrent(guard, previewEpochRef.current)) return;
                const token = result.confirmationToken;
                if (token) {
                    confirmationRef.current = { identity, token, target };
                }
                setPreview({ open: true, operation, phase: "ready", result });
            } catch (error) {
                if (!isCurrent(guard, previewEpochRef.current)) return;
                const message = errorMessage(error);
                setPreview({ open: true, operation, phase: "error", errorMessage: message });
                if (!isCurrent(guard, previewEpochRef.current)) return;
                reportError(message);
            }
        },
        [isCurrent, reportError]
    );

    const openRewind = useCallback(
        (turnId: string): Promise<void> => openPreview({ kind: "rewind", targetTurnId: turnId }),
        [openPreview]
    );

    const openRedo = useCallback((): Promise<void> => openPreview({ kind: "redo" }), [openPreview]);

    const selectRewindPoint = useCallback(
        async (turnId: string): Promise<void> => {
            const capture = selectorCaptureRef.current;
            if (!capture || !capture.eligibleTurnIds.has(turnId) || !isCurrent(capture, selectorEpochRef.current)) {
                return;
            }
            const onRevealTurn = optionsRef.current.onRevealTurn;
            await onRevealTurn(turnId);
            if (selectorCaptureRef.current !== capture || !isCurrent(capture, selectorEpochRef.current)) return;
            await openRewind(turnId);
        },
        [isCurrent, openRewind]
    );

    const closeSelector = useCallback((): void => {
        selectorEpochRef.current++;
        selectorCaptureRef.current = undefined;
        if (!mountedRef.current) return;
        setSelector(IdleSelectorState);
    }, []);

    const cancelPreview = useCallback((): void => {
        previewEpochRef.current++;
        applyEpochRef.current++;
        applyInFlightRef.current = false;
        confirmationRef.current = undefined;
        if (!mountedRef.current) return;
        setPreview(IdlePreviewState);
    }, []);

    const confirmPreview = useCallback(
        async (mode: "normal" | "force-drift"): Promise<void> => {
            const confirmation = confirmationRef.current;
            if (!mountedRef.current || applyInFlightRef.current || !confirmation) return;
            if (!sameIdentity(confirmation.identity, identityRef.current)) return;
            const epoch = ++applyEpochRef.current;
            const guard = {
                identity: confirmation.identity,
                lifetime: lifetimeRef.current,
                epoch,
            };
            const client = optionsRef.current.client;
            applyInFlightRef.current = true;
            confirmationRef.current = undefined;
            setPreview((current) => ({ ...current, phase: "applying", errorMessage: undefined }));
            try {
                const result =
                    confirmation.target.kind === "rewind"
                        ? await client.rewindTree({
                              sessionMetadata: confirmation.identity.sessionMetadata,
                              expectedSemanticLeafId: confirmation.identity.semanticLeafId,
                              targetTurnId: confirmation.target.targetTurnId,
                              mode,
                              confirmationToken: confirmation.token,
                          })
                        : await client.redoRewind({
                              sessionMetadata: confirmation.identity.sessionMetadata,
                              expectedSemanticLeafId: confirmation.identity.semanticLeafId,
                              confirmationToken: confirmation.token,
                          });
                if (!isCurrent(guard, applyEpochRef.current)) return;
                applyInFlightRef.current = false;
                setPreview(IdlePreviewState);
                if (result.editorText != null) {
                    if (!isCurrent(guard, applyEpochRef.current)) return;
                    optionsRef.current.onEditorText(result.editorText);
                }
            } catch (error) {
                if (!isCurrent(guard, applyEpochRef.current)) return;
                applyInFlightRef.current = false;
                const message = errorMessage(error);
                setPreview((current) => ({ ...current, phase: "error", errorMessage: message }));
                if (!isCurrent(guard, applyEpochRef.current)) return;
                reportError(message);
            }
        },
        [isCurrent, reportError]
    );

    const rewindableTurnIds = useMemo<ReadonlySet<string>>(
        () => new Set(options.rewindState.eligibleTurnIds),
        [options.rewindState.eligibleTurnIds]
    );
    const busy =
        options.rewindState.busy ||
        options.rewindState.frozen ||
        preview.phase === "applying" ||
        (preview.open && preview.phase === "loading");

    return {
        selector,
        preview,
        busy,
        rewindableTurnIds,
        openSelector,
        selectRewindPoint,
        openRewind,
        openRedo,
        closeSelector,
        cancelPreview,
        confirmPreview,
    };
}
