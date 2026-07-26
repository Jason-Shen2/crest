// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { AgentPtyScreenView } from "./agent-pty-screen-view";
import type { AgentRuntimeClient } from "./agent-runtime-client";
import { useAgentSurfaceActivityController } from "./agent-surface-activity";

const AgentCommandCellWidthPx = 8;
const AgentCommandCellHeightPx = 20;

function measureAgentCommandSize(element: HTMLElement): { cols: number; rows: number } {
    const rect = element.getBoundingClientRect();
    return {
        cols: Math.max(1, Math.floor(rect.width / AgentCommandCellWidthPx)),
        rows: Math.max(1, Math.floor(rect.height / AgentCommandCellHeightPx)),
    };
}

export function AgentCommandCard({
    client,
    session,
    snapshot,
}: {
    client: AgentRuntimeClient;
    session: AgentSessionMeta;
    snapshot: AgentPtySnapshot;
}) {
    const activity = useAgentSurfaceActivityController();
    const [input, setInput] = useState("");
    const screenMeasureRef = useRef<HTMLDivElement>(null);
    const observerRef = useRef<ResizeObserver>(null);
    const lastResizeRef = useRef("");

    const reportMeasuredSize = useCallback(() => {
        if (!activity.getActive() || !snapshot.running) {
            return;
        }
        const element = screenMeasureRef.current;
        if (!element) {
            return;
        }
        const size = measureAgentCommandSize(element);
        const resizeKey = `${session.path}:${snapshot.commandId}:${size.cols}x${size.rows}`;
        if (lastResizeRef.current === resizeKey) {
            return;
        }
        lastResizeRef.current = resizeKey;
        void client.commandResize(session, snapshot.commandId, size.cols, size.rows);
    }, [activity, client, session, snapshot.commandId, snapshot.running]);

    const disconnectObserver = useCallback(() => {
        observerRef.current?.disconnect();
        observerRef.current = null;
    }, []);

    const connectObserver = useCallback(() => {
        if (!activity.getActive() || !snapshot.running) {
            return;
        }
        reportMeasuredSize();
        const element = screenMeasureRef.current;
        if (!element || typeof ResizeObserver === "undefined") {
            return;
        }
        disconnectObserver();
        const observer = new ResizeObserver(reportMeasuredSize);
        observer.observe(element);
        observerRef.current = observer;
    }, [activity, disconnectObserver, reportMeasuredSize, snapshot.running]);

    useLayoutEffect(() => {
        connectObserver();
        const unsubscribe = activity.subscribe((active) => {
            if (active) {
                connectObserver();
                return;
            }
            disconnectObserver();
        });
        return () => {
            unsubscribe();
            disconnectObserver();
        };
    }, [activity, connectObserver, disconnectObserver]);

    const submitInput = () => {
        if (!activity.getActive() || !snapshot.running || !input) {
            return;
        }
        void client.commandWrite(session, snapshot.commandId, `${input}\n`);
        setInput("");
    };

    const stopCommand = () => {
        if (!activity.getActive() || !snapshot.running) {
            return;
        }
        void client.commandStop(session, snapshot.commandId);
    };

    return (
        <div
            className={cn(
                "rounded-xl border border-border/70 bg-panel/80 p-3",
                snapshot.needsUserInput ? "ring-1 ring-accent/70" : ""
            )}
            data-needs-user-input={String(snapshot.needsUserInput)}
            data-testid="agent-command-card"
        >
            <div className="mb-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate font-mono text-xs text-foreground">{snapshot.command}</div>
                    <div className="truncate text-xs text-secondary">{snapshot.cwd}</div>
                </div>
                {snapshot.running ? (
                    <button className="cursor-pointer rounded px-2 py-1 text-xs" type="button" onClick={stopCommand}>
                        Stop command
                    </button>
                ) : null}
            </div>
            <div ref={screenMeasureRef}>
                <AgentPtyScreenView snapshot={snapshot} />
            </div>
            <input
                aria-label="Command input"
                className="mt-2 w-full rounded border border-border/70 bg-background px-2 py-1 font-mono text-xs"
                disabled={!snapshot.running}
                value={input}
                onChange={(event) => {
                    if (!activity.getActive()) {
                        return;
                    }
                    setInput(event.target.value);
                }}
                onKeyDown={(event) => {
                    if (event.key !== "Enter") {
                        return;
                    }
                    event.preventDefault();
                    submitInput();
                }}
            />
        </div>
    );
}
