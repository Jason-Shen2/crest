// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceAgentContextState } from "@/app/workspace/workspace-agent-model";
import { ContextComposition } from "./context-composition";
import {
    formatContextAccuracy,
    formatContextLifecycle,
    formatContextPercent,
    formatContextTimestamp,
    formatContextTokens,
} from "./context-format";
import { ContextInventory } from "./context-inventory";

function effectiveLifecycle(state: WorkspaceAgentContextState): AgentContextSnapshotLifecycleView {
    if (state.status === "loading") return "updating";
    if (state.status === "out_of_date") return "out_of_date";
    if (state.status === "error") return "unavailable";
    return state.snapshot?.lifecycle ?? "unavailable";
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className="min-w-0 rounded-md bg-fg-overlay-1 px-2.5 py-2">
            <div className="truncate text-[10px] text-muted-foreground">{label}</div>
            <div className="mt-0.5 truncate font-mono text-xs tabular-nums text-foreground">{value}</div>
        </div>
    );
}

export function ContextInspector({ state }: { state?: WorkspaceAgentContextState | null }) {
    if (!state || (state.status === "loading" && !state.snapshot)) {
        return (
            <section
                aria-label="Context Inspector"
                className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground"
            >
                Building effective context…
            </section>
        );
    }
    if (!state.snapshot) {
        return (
            <section aria-label="Context Inspector" className="flex h-full items-center justify-center p-6 text-center">
                <div>
                    <h2 className="text-sm font-medium text-foreground">Context unavailable</h2>
                    <p className="mt-1 max-w-64 text-xs text-muted-foreground">
                        {state.errorMessage ?? "No trustworthy context inventory is available for this Agent."}
                    </p>
                </div>
            </section>
        );
    }

    const snapshot = state.snapshot;
    const lifecycle = effectiveLifecycle(state);
    const statusTone =
        lifecycle === "out_of_date" || lifecycle === "unavailable"
            ? "bg-warning/15 text-foreground"
            : "bg-accent/12 text-foreground";
    return (
        <section aria-label="Context Inspector" className="flex h-full min-w-0 flex-col overflow-hidden">
            <header className="sticky top-0 z-10 border-b border-border/60 bg-panel/95 px-4 py-3 backdrop-blur-sm">
                <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="truncate text-sm font-semibold text-foreground">Current context</h2>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{snapshot.modelLabel}</p>
                    </div>
                    <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone}`}>
                            {formatContextLifecycle(lifecycle)}
                        </span>
                        <span className="rounded-full bg-fg-overlay-2 px-2 py-0.5 text-[10px] text-muted-foreground">
                            {formatContextAccuracy(snapshot.accuracy)}
                        </span>
                    </div>
                </div>
                <div className="mt-2 text-[10px] text-muted-foreground">
                    Updated {formatContextTimestamp(snapshot.generatedAt)}
                </div>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                <div className="mx-auto w-full max-w-3xl space-y-5">
                    <section aria-labelledby="context-capacity-title" className="space-y-3">
                        <div className="flex items-end justify-between gap-3">
                            <div>
                                <h3 id="context-capacity-title" className="text-xs font-semibold text-foreground">
                                    Input capacity
                                </h3>
                                <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-foreground">
                                    {formatContextTokens(snapshot.effectiveInputTokens)} /{" "}
                                    {formatContextTokens(snapshot.inputCapacity)}
                                </p>
                            </div>
                            <span className="font-mono text-xs tabular-nums text-muted-foreground">
                                {formatContextPercent(snapshot.effectiveInputTokens, snapshot.inputCapacity)}
                            </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-fg-overlay-2">
                            <div
                                aria-label="Effective input usage"
                                className="h-full rounded-full bg-accent transition-[width] duration-300"
                                style={{
                                    width: `${Math.min(
                                        100,
                                        snapshot.effectiveInputTokens == null || snapshot.inputCapacity <= 0
                                            ? 0
                                            : (snapshot.effectiveInputTokens / snapshot.inputCapacity) * 100
                                    )}%`,
                                }}
                            />
                        </div>
                        <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-3">
                            <Stat label="Full window" value={formatContextTokens(snapshot.contextWindow)} />
                            <Stat label="Output reserve" value={formatContextTokens(snapshot.outputReserve)} />
                            <Stat label="Remaining input" value={formatContextTokens(snapshot.remainingInputTokens)} />
                        </div>
                    </section>

                    <ContextComposition snapshot={snapshot} />
                    <ContextInventory categories={snapshot.categories} items={snapshot.items} />

                    {state.status === "out_of_date" && state.errorMessage ? (
                        <p className="rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-[11px] text-foreground">
                            Refresh failed: {state.errorMessage}. Showing the last matching snapshot.
                        </p>
                    ) : null}
                    {snapshot.diagnostic ? (
                        <p className="rounded-md bg-fg-overlay-1 px-3 py-2 text-[11px] text-muted-foreground">
                            {snapshot.diagnostic}
                        </p>
                    ) : null}
                </div>
            </div>
        </section>
    );
}
