// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type TopTabPerformanceMark =
    | "top-tab-open"
    | "top-tab-activate"
    | "top-tab-first-content"
    | "workspace-checkpoint-error";

export interface TopTabPerformanceDetail {
    kind: "file" | "preview" | "git-diff" | "agent-turn-diff" | "workspace";
    id: string;
    duration: number;
}

function safeDateNow(): number {
    try {
        const now = Date.now();
        return Number.isFinite(now) ? now : 0;
    } catch {
        return 0;
    }
}

export function topTabPerformanceNow(): number {
    try {
        const now = globalThis.performance?.now?.();
        return Number.isFinite(now) ? now : safeDateNow();
    } catch {
        return safeDateNow();
    }
}

function isDevelopment(): boolean {
    if (!import.meta.env.DEV) {
        return false;
    }
    try {
        return typeof process === "undefined" || process?.env?.NODE_ENV !== "production";
    } catch {
        return false;
    }
}

export function recordTopTabPerformance(name: TopTabPerformanceMark, detail: TopTabPerformanceDetail): void {
    try {
        if (!isDevelopment()) {
            return;
        }
        globalThis.performance?.mark?.(name, {
            detail: {
                kind: detail.kind,
                id: detail.id,
                duration: Number.isFinite(detail.duration) ? Math.max(0, detail.duration) : 0,
            },
        });
    } catch {
        return;
    }
}
