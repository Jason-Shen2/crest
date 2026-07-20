// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Adapted from Langfuse ObservationDetailView.

import { useState, type ReactNode } from "react";

import { DetailSection } from "./detail-primitives";
import { IOPreview } from "./io-preview";

type DetailTab = "preview" | "json";

function finiteValues(record: Record<string, number>): [string, number][] {
    return Object.entries(record ?? {}).filter((entry): entry is [string, number] => Number.isFinite(entry[1]));
}

function totalTokens(usage: Record<string, number>): number | null {
    if (Number.isFinite(usage?.totalTokens)) {
        return usage.totalTokens;
    }
    const total = (usage?.input ?? 0) + (usage?.output ?? 0);
    return total > 0 ? total : null;
}

function totalCost(cost: Record<string, number>): number | null {
    if (Number.isFinite(cost?.total)) {
        return cost.total;
    }
    const values = finiteValues(cost).map(([, value]) => value);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
}

function formatSeconds(seconds: number): string {
    return seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds.toFixed(2)}s`;
}

function Metric({ children }: { children: ReactNode }) {
    return (
        <span className="rounded-full border border-border px-2 py-1 text-[10px] text-muted-foreground">
            {children}
        </span>
    );
}

function DetailTabs({ value, onChange }: { value: DetailTab; onChange: (value: DetailTab) => void }) {
    return (
        <div role="tablist" aria-label="Observation detail view" className="flex border-b border-border px-3">
            {(["preview", "json"] as const).map((tab) => (
                <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={value === tab}
                    className="cursor-pointer border-b-2 border-transparent px-3 py-2 text-xs capitalize text-muted-foreground aria-selected:border-accent aria-selected:text-foreground"
                    onClick={() => onChange(tab)}
                >
                    {tab === "json" ? "JSON" : "Preview"}
                </button>
            ))}
        </div>
    );
}

function KeyValueSection({ label, entries }: { label: string; entries: [string, number][] }) {
    if (entries.length === 0) {
        return null;
    }
    return (
        <DetailSection label={label}>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs">
                {entries.map(([key, value]) => (
                    <div key={key} className="contents">
                        <dt className="break-words text-muted-foreground">{key}</dt>
                        <dd className="font-mono">{value}</dd>
                    </div>
                ))}
            </dl>
        </DetailSection>
    );
}

function hasMetadata(metadata: Record<string, unknown>): boolean {
    return Object.keys(metadata ?? {}).length > 0;
}

export function ObservationDetailView({ observation }: { trace: Trace; observation: Observation }) {
    const [tab, setTab] = useState<DetailTab>("preview");
    const usageEntries = finiteValues(observation.usageDetails);
    const costEntries = finiteValues(observation.costDetails);
    const tokens = totalTokens(observation.usageDetails);
    const cost = totalCost(observation.costDetails);

    return (
        <div role="region" aria-label="Observation detail" className="flex h-full min-h-0 flex-col">
            <header
                role="banner"
                aria-label="Observation header"
                className="shrink-0 space-y-2 border-b border-border p-3"
            >
                <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {observation.type}
                </div>
                <h2 className="truncate text-base font-semibold">{observation.name ?? observation.id}</h2>
                <div className="flex flex-wrap gap-1">
                    <Metric>{observation.level}</Metric>
                    {observation.statusMessage ? <Metric>{observation.statusMessage}</Metric> : null}
                    {observation.latency == null ? null : <Metric>{formatSeconds(observation.latency)}</Metric>}
                    {observation.timeToFirstToken == null ? null : (
                        <Metric>{`TTFT ${formatSeconds(observation.timeToFirstToken)}`}</Metric>
                    )}
                    {observation.model == null ? null : <Metric>{observation.model}</Metric>}
                    {tokens == null ? null : <Metric>{`${tokens} tokens`}</Metric>}
                    {cost == null ? null : <Metric>{`$${cost}`}</Metric>}
                </div>
            </header>
            <DetailTabs value={tab} onChange={setTab} />
            <div className="min-h-0 flex-1 overflow-auto">
                {tab === "preview" ? (
                    <div className="flex flex-col gap-3 p-3">
                        <IOPreview label="Input" value={observation.input} copyScopeKey={observation.id} />
                        <IOPreview label="Output" value={observation.output} copyScopeKey={observation.id} />
                        {hasMetadata(observation.metadata) ? (
                            <IOPreview label="Metadata" value={observation.metadata} copyScopeKey={observation.id} />
                        ) : null}
                        <KeyValueSection label="Usage" entries={usageEntries} />
                        <KeyValueSection label="Cost" entries={costEntries} />
                    </div>
                ) : (
                    <pre className="m-3 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-fg-overlay-1/20 p-3 font-mono text-[11px]">
                        {JSON.stringify(observation, null, 2)}
                    </pre>
                )}
            </div>
        </div>
    );
}
