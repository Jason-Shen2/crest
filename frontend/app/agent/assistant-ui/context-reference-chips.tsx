// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

"use client";

import { AlertCircle, Link2, Loader2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { ContextReferenceDraftState } from "@/app/store/context-references";
import { cn } from "@/util/util";

const ControlClassName =
    "min-h-7 cursor-pointer rounded-md px-2 text-xs outline-none transition-colors hover:bg-fg-overlay-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : "The action failed. Try again.";
}

function workspaceName(value: string): string | undefined {
    return value
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .filter(Boolean)
        .at(-1);
}

function Provenance({ value }: { value: AgentContextProvenanceView }): ReactNode {
    const title = value.sourceSessionTitle?.trim() || workspaceName(value.sourceCwd) || "Untitled session";
    return (
        <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-xs font-medium text-foreground">{title}</span>
                <span className="shrink-0 rounded bg-fg-overlay-1 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {value.sourceKind === "turn" ? "Turn" : "Session"}
                </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{value.preview}</p>
        </div>
    );
}

function Badge({ children }: { children: ReactNode }): ReactNode {
    return <span className="shrink-0 rounded bg-fg-overlay-1 px-2 py-1 text-xs text-muted-foreground">{children}</span>;
}

export interface ContextReferenceDraftChipProps {
    draft: ContextReferenceDraftState;
    onSummarize: (draftId: string) => Promise<void>;
    onDiscard: (draftId: string) => Promise<void>;
    readOnly?: boolean;
}

export function ContextReferenceDraftChip({
    draft,
    onSummarize,
    onDiscard,
    readOnly = false,
}: ContextReferenceDraftChipProps): ReactNode {
    const [pending, setPending] = useState<"summary" | "discard">();
    const [localError, setLocalError] = useState<string>();
    const mountedRef = useRef(true);
    const id = draft.view.draftId;
    const locked = draft.status === "sending" || draft.status === "summarizing" || pending != null;

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    useEffect(() => {
        setLocalError(undefined);
    }, [id, draft.status, draft.errorMessage, draft.view.summaryStatus]);

    const perform = async (kind: "summary" | "discard", action: () => Promise<void>) => {
        if (locked || (readOnly && kind !== "discard")) {
            return;
        }
        setPending(kind);
        setLocalError(undefined);
        try {
            await action();
        } catch (error) {
            if (mountedRef.current) {
                setLocalError(errorMessage(error));
            }
        } finally {
            if (mountedRef.current) {
                setPending(undefined);
            }
        }
    };

    const shownError = localError || draft.errorMessage;
    return (
        <article className="rounded-lg border border-border/60 bg-background/60 p-2" aria-label="Draft reference">
            <div className="flex items-start gap-2">
                <Link2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <Provenance value={draft.view.provenance} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
                <Badge>{draft.deliveryScope === "conversation" ? "Conversation" : "This message"}</Badge>
                <Badge>{draft.requestedRepresentation === "summary" ? "Summary" : "Full"}</Badge>
                <button
                    type="button"
                    aria-label={localError && pending !== "summary" ? "Retry discard reference" : "Discard reference"}
                    disabled={locked}
                    onClick={() => void perform("discard", () => onDiscard(id))}
                    className={cn(ControlClassName, "ml-auto px-1.5 text-muted-foreground hover:text-destructive")}
                >
                    {pending === "discard" ? (
                        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                    ) : (
                        <Trash2 aria-hidden="true" className="size-3.5" />
                    )}
                </button>
            </div>
            {(pending === "summary" || draft.status === "summarizing") && (
                <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground" role="status">
                    <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                    Generating summary…
                </p>
            )}
            {draft.status === "sending" && <p className="mt-1.5 text-xs text-muted-foreground">Queued for send</p>}
            {shownError && (
                <div className="mt-1.5 flex items-center gap-2 text-xs text-destructive" role="alert">
                    <AlertCircle aria-hidden="true" className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1">{shownError}</span>
                    {draft.requestedRepresentation === "summary" && draft.status === "error" && !localError && (
                        <button
                            type="button"
                            aria-label="Retry summary"
                            disabled={locked || readOnly}
                            onClick={() => void perform("summary", () => onSummarize(id))}
                            className={ControlClassName}
                        >
                            Retry summary
                        </button>
                    )}
                </div>
            )}
        </article>
    );
}

export interface ContextSendRecoveryRowProps {
    errorMessage: string;
    onRetry: () => Promise<void>;
}

export function ContextSendRecoveryRow({ errorMessage, onRetry }: ContextSendRecoveryRowProps): ReactNode {
    const [pending, setPending] = useState(false);
    return (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2 text-xs" role="alert">
            <div className="flex items-center gap-2">
                <AlertCircle aria-hidden="true" className="size-4 shrink-0 text-destructive" />
                <span className="min-w-0 flex-1 text-foreground">{errorMessage}</span>
                <button
                    type="button"
                    aria-label="Retry send"
                    disabled={pending}
                    onClick={() => {
                        if (pending) {
                            return;
                        }
                        setPending(true);
                        void onRetry().finally(() => setPending(false));
                    }}
                    className={cn(ControlClassName, "shrink-0 bg-accent/80 text-primary hover:bg-accent")}
                >
                    Retry
                </button>
            </div>
            <p className="mt-1.5 text-muted-foreground">Adjust the referenced context or request, then retry.</p>
        </div>
    );
}

export interface ContextReferenceBarProps {
    drafts: ContextReferenceDraftState[];
    recovery?: { errorMessage: string };
    onSummarizeDraft: (draftId: string) => Promise<void>;
    onDiscardDraft: (draftId: string) => Promise<void>;
    onRetrySend: () => Promise<void>;
    readOnly?: boolean;
    operatorMaxTokens?: number;
}

export function ContextReferenceBar({
    drafts,
    recovery,
    onSummarizeDraft,
    onDiscardDraft,
    onRetrySend,
    readOnly = false,
    operatorMaxTokens,
}: ContextReferenceBarProps): ReactNode {
    if (drafts.length === 0 && !recovery) {
        return null;
    }
    return (
        <section aria-label="Context references" className="flex flex-col gap-2">
            {readOnly && (
                <p className="rounded-md border border-border/50 bg-background/50 px-2 py-1.5 text-xs text-muted-foreground">
                    References disabled. Existing drafts can still be discarded.
                </p>
            )}
            {operatorMaxTokens != null && (
                <p className="text-xs text-muted-foreground">
                    Reference token cap: {operatorMaxTokens.toLocaleString()}
                </p>
            )}
            {drafts.map((draft) => (
                <ContextReferenceDraftChip
                    key={draft.view.draftId}
                    draft={draft}
                    onSummarize={onSummarizeDraft}
                    onDiscard={onDiscardDraft}
                    readOnly={readOnly}
                />
            ))}
            {recovery && !readOnly && (
                <ContextSendRecoveryRow errorMessage={recovery.errorMessage} onRetry={onRetrySend} />
            )}
        </section>
    );
}
