// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useEffect, useRef, useState } from "react";

interface ObservationDetailProps {
    observation: Observation;
    traceTimestamp: string;
}

function stringifyValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    return JSON.stringify(value, null, 2);
}

function hasEntries(value: Record<string, unknown>): boolean {
    return Object.keys(value).length > 0;
}

function formatSeconds(seconds: number): string {
    const milliseconds = seconds * 1000;
    if (milliseconds < 1000) {
        return `${Math.round(milliseconds)} ms`;
    }
    return `${Number(seconds.toFixed(2))} s`;
}

function formatRelativeTime(startTime: string, traceTimestamp: string): string {
    const seconds = (new Date(startTime).getTime() - new Date(traceTimestamp).getTime()) / 1000;
    return Number.isFinite(seconds) ? `+${Math.max(0, seconds).toFixed(1)}s` : "+0.0s";
}

function formatDuration(observation: Observation): string {
    if (observation.endTime == null) {
        return "running";
    }
    const seconds = (new Date(observation.endTime).getTime() - new Date(observation.startTime).getTime()) / 1000;
    return Number.isFinite(seconds) && seconds >= 0 ? formatSeconds(seconds) : "unknown";
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <section className="border-t border-border/70 pt-3 first:border-t-0 first:pt-0">
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
            {children}
        </section>
    );
}

function JsonValue({ value }: { value: unknown }) {
    return (
        <pre className="overflow-auto whitespace-pre-wrap break-words rounded border border-border/70 bg-fg-overlay-1/30 p-2 font-mono text-[11px] text-foreground">
            {stringifyValue(value)}
        </pre>
    );
}

export function ObservationDetail({ observation, traceTimestamp }: ObservationDetailProps) {
    const [wrapRaw, setWrapRaw] = useState(false);
    const [copyStatus, setCopyStatus] = useState<"idle" | "success" | "error">("idle");
    const copyRequestToken = useRef(0);
    const usageEntries = Object.entries(observation.usageDetails).filter(([, value]) => typeof value === "number");
    const costEntries = Object.entries(observation.costDetails).filter(([, value]) => typeof value === "number");
    const timingEntries = [
        observation.latency == null
            ? null
            : { id: "latency", label: "Latency", value: formatSeconds(observation.latency) },
        observation.timeToFirstToken == null
            ? null
            : { id: "ttft", label: "TTFT", value: formatSeconds(observation.timeToFirstToken) },
    ].filter((entry) => entry != null);
    const hasUsage = usageEntries.length > 0 || costEntries.length > 0 || timingEntries.length > 0;
    const hasMetadata = hasEntries(observation.metadata);
    const rawJson = JSON.stringify(observation, null, 2);

    useEffect(() => {
        copyRequestToken.current += 1;
        setCopyStatus("idle");
        return () => {
            copyRequestToken.current += 1;
        };
    }, [observation.id]);

    const copyRawJson = async () => {
        const requestToken = ++copyRequestToken.current;
        try {
            if (typeof navigator === "undefined" || navigator.clipboard?.writeText == null) {
                throw new Error("Clipboard API unavailable");
            }
            await navigator.clipboard.writeText(rawJson);
            if (requestToken === copyRequestToken.current) {
                setCopyStatus("success");
            }
        } catch {
            if (requestToken === copyRequestToken.current) {
                setCopyStatus("error");
            }
        }
    };

    return (
        <article aria-label="Observation detail" className="flex min-h-0 flex-col gap-3 text-xs text-foreground">
            <DetailSection title="Overview">
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                    <dt className="text-muted-foreground">Status</dt>
                    <dd>{observation.level}</dd>
                    <dt className="text-muted-foreground">Name</dt>
                    <dd className="break-words">{observation.name}</dd>
                    <dt className="text-muted-foreground">Type</dt>
                    <dd>{observation.type}</dd>
                    {observation.model ? (
                        <>
                            <dt className="text-muted-foreground">Model</dt>
                            <dd className="break-words">{observation.model}</dd>
                        </>
                    ) : null}
                    <dt className="text-muted-foreground">Relative time</dt>
                    <dd className="font-mono text-[11px]">
                        {formatRelativeTime(observation.startTime, traceTimestamp)}
                    </dd>
                    <dt className="text-muted-foreground">Duration</dt>
                    <dd className="font-mono text-[11px]">{formatDuration(observation)}</dd>
                    {observation.statusMessage ? (
                        <>
                            <dt className="text-muted-foreground">Message</dt>
                            <dd className="break-words">{observation.statusMessage}</dd>
                        </>
                    ) : null}
                </dl>
            </DetailSection>
            {observation.input != null ? (
                <DetailSection title="Input">
                    <JsonValue value={observation.input} />
                </DetailSection>
            ) : null}
            {observation.output != null ? (
                <DetailSection title="Output">
                    <JsonValue value={observation.output} />
                </DetailSection>
            ) : null}
            {hasUsage ? (
                <DetailSection title="Usage">
                    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
                        {[
                            ...timingEntries,
                            ...usageEntries.map(([key, value]) => ({ id: `usage-${key}`, label: key, value })),
                            ...costEntries.map(([key, value]) => ({ id: `cost-${key}`, label: `cost.${key}`, value })),
                        ].map(({ id, label, value }) => (
                            <div key={id} className="contents">
                                <dt className="break-words text-muted-foreground">{label}</dt>
                                <dd className="font-mono">{value}</dd>
                            </div>
                        ))}
                    </dl>
                </DetailSection>
            ) : null}
            {hasMetadata ? (
                <DetailSection title="Metadata">
                    <JsonValue value={observation.metadata} />
                </DetailSection>
            ) : null}
            <DetailSection title="Raw">
                <div className="mb-2 flex items-center gap-2">
                    <button
                        type="button"
                        aria-label="Copy observation JSON"
                        className="cursor-pointer rounded border border-border px-2 py-1 text-muted-foreground transition-colors hover:bg-fg-overlay-2 hover:text-foreground"
                        onClick={copyRawJson}
                    >
                        {copyStatus === "success" ? "Copied" : "Copy"}
                    </button>
                    <button
                        type="button"
                        aria-label="Wrap raw JSON"
                        aria-pressed={wrapRaw}
                        className="cursor-pointer rounded border border-border px-2 py-1 text-muted-foreground transition-colors hover:bg-fg-overlay-2 hover:text-foreground"
                        onClick={() => setWrapRaw((current) => !current)}
                    >
                        Wrap
                    </button>
                    {copyStatus !== "idle" ? (
                        <span
                            role="status"
                            aria-live="polite"
                            className={copyStatus === "error" ? "text-red-500" : "text-muted-foreground"}
                        >
                            {copyStatus === "success" ? "Copied" : "Copy failed"}
                        </span>
                    ) : null}
                </div>
                <pre
                    className={cn(
                        "overflow-auto rounded border border-border/70 bg-fg-overlay-1/30 p-2 font-mono text-[11px] text-foreground",
                        wrapRaw ? "whitespace-pre-wrap break-words" : "whitespace-pre"
                    )}
                >
                    {rawJson}
                </pre>
            </DetailSection>
        </article>
    );
}
