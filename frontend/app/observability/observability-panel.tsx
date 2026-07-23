// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { TracePanel } from "./trace-panel/trace-panel";
import { TraceSelector } from "./trace-selector";

const ObservabilitySurfaceStyle = {
    "--observability-panel-bg": "rgb(from var(--color-panel) r g b / 90%)",
    "--observability-workspace-bg": "rgb(from var(--color-panel) r g b / 92%)",
    "--observability-drawer-bg": "rgb(from var(--color-panel) r g b / 96%)",
} as CSSProperties;

export type AgentObservabilityApi = Window["api"]["agentObservability"];

interface ObservabilityPanelProps {
    api?: AgentObservabilityApi;
    magnified?: boolean;
    sessionId?: string;
}

type LoadState = "unavailable" | "loading" | "ready" | "empty" | "error";

export function ObservabilityPanel({ api: injectedApi, magnified = false, sessionId }: ObservabilityPanelProps = {}) {
    const api = injectedApi ?? (typeof window === "undefined" ? undefined : window.api?.agentObservability);
    const [traces, setTraces] = useState<Trace[]>([]);
    const [selectedTraceDetail, setSelectedTraceDetail] = useState<TraceDetail | undefined>();
    const [loadState, setLoadState] = useState<LoadState>(api && sessionId ? "loading" : "unavailable");
    const [selectedTraceId, setSelectedTraceId] = useState<string | undefined>();
    const selectedTraceIdRef = useRef<string | undefined>(undefined);
    const requestIdRef = useRef(0);

    const loadTrace = async (traceId: string) => {
        if (!api || !sessionId) {
            return;
        }
        const requestId = ++requestIdRef.current;
        selectedTraceIdRef.current = traceId;
        setSelectedTraceId(traceId);
        setLoadState("loading");
        try {
            const detail = await api.getTrace(traceId, sessionId);
            if (requestId !== requestIdRef.current || selectedTraceIdRef.current !== traceId) {
                return;
            }
            if (!detail) {
                setLoadState("error");
                return;
            }
            setSelectedTraceDetail(detail);
            setLoadState("ready");
        } catch {
            if (requestId === requestIdRef.current && selectedTraceIdRef.current === traceId) {
                setLoadState("error");
            }
        }
    };

    useEffect(() => {
        selectedTraceIdRef.current = undefined;
        setSelectedTraceId(undefined);
        requestIdRef.current += 1;
        setTraces([]);
        setSelectedTraceDetail(undefined);
        if (!api || !sessionId) {
            setLoadState("unavailable");
            return;
        }
        let disposed = false;
        setLoadState("loading");
        const unsubscribe = api.subscribe(sessionId, (event) => {
            setTraces((current) => {
                const withoutUpdated = current.filter((trace) => trace.id !== event.detail.trace.id);
                return [event.detail.trace, ...withoutUpdated];
            });
            if (selectedTraceIdRef.current && selectedTraceIdRef.current !== event.detail.trace.id) {
                return;
            }
            selectedTraceIdRef.current = event.detail.trace.id;
            setSelectedTraceId(event.detail.trace.id);
            requestIdRef.current += 1;
            setSelectedTraceDetail(event.detail);
            setLoadState("ready");
        });
        void api
            .listTraces(sessionId)
            .then((items) => {
                if (disposed) {
                    return;
                }
                setTraces((current) => [
                    ...current,
                    ...items.filter((item) => !current.some((trace) => trace.id === item.id)),
                ]);
                const first = items[0];
                if (!first) {
                    if (!selectedTraceIdRef.current) {
                        setLoadState("empty");
                    }
                    return;
                }
                if (selectedTraceIdRef.current) {
                    return;
                }
                void loadTrace(first.id);
            })
            .catch(() => {
                if (!disposed) {
                    setLoadState("error");
                }
            });
        return () => {
            disposed = true;
            requestIdRef.current += 1;
            unsubscribe();
        };
    }, [api, sessionId]);

    return (
        <section
            aria-label="Agent Observability"
            className="flex h-full min-h-0 flex-col bg-[var(--observability-panel-bg)] text-foreground"
            style={ObservabilitySurfaceStyle}
        >
            <div className="border-b border-border px-3 py-2">
                <div className="text-sm font-medium text-primary">Agent Observability</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                    Single trace view powered by Langfuse-compatible data.
                </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-3">
                {traces.length > 0 ? (
                    <TraceSelector traces={traces} selectedTraceId={selectedTraceId} onSelectTrace={loadTrace} />
                ) : null}
                {loadState === "unavailable" ? <div className="text-sm">Observability is unavailable.</div> : null}
                {loadState === "loading" ? <div className="text-sm">Loading recent runs...</div> : null}
                {loadState === "empty" ? <div className="text-sm">No runs recorded.</div> : null}
                {loadState === "error" ? <div className="text-sm">Unable to load recent runs.</div> : null}
                {selectedTraceDetail ? (
                    <div hidden={loadState !== "ready"} className="min-h-0 flex-1">
                        <TracePanel detail={selectedTraceDetail} layout={magnified ? "desktop" : "compact"} />
                    </div>
                ) : null}
            </div>
        </section>
    );
}
