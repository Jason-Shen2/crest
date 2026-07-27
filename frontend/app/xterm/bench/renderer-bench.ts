// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { poolSlotStats, type PoolSlotStat } from "../renderer-pool";
import { getSessionBlockMode, interruptSession, submitToSession, subscribeSessionBlockMode } from "../xterm-session";
import { summarizeFrameSamples, type FrameSummary } from "./metrics";

type ChromiumPerformance = Performance & {
    memory?: {
        usedJSHeapSize?: number;
    };
};

export type CommandBenchmarkOptions = {
    blockId: string;
    command: string;
    timeoutMs?: number;
    interruptOnTimeout?: boolean;
};

export type CommandBenchmarkResult = FrameSummary & {
    blockId: string;
    command: string;
    startedAt: string;
    slotsBefore: PoolSlotStat[];
    slotsAfter: PoolSlotStat[];
};

function heapBytes(): number | null {
    return (performance as ChromiumPerformance).memory?.usedJSHeapSize ?? null;
}

function sampleRefreshFrames(sampleCount = 30, timeoutMs = 2_000): Promise<number[]> {
    return new Promise((resolve) => {
        const frameTimesMs: number[] = [];
        let lastFrame: number | null = null;
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            resolve(frameTimesMs);
        };
        const sample = (timestamp: number) => {
            if (settled) return;
            if (lastFrame != null) frameTimesMs.push(timestamp - lastFrame);
            lastFrame = timestamp;
            if (frameTimesMs.length >= sampleCount) {
                finish();
            } else {
                requestAnimationFrame(sample);
            }
        };
        const timer = window.setTimeout(finish, timeoutMs);
        requestAnimationFrame(sample);
    });
}

function waitForPrompt(blockId: string, timeoutMs: number): Promise<void> {
    if (getSessionBlockMode(blockId) === "prompt") return Promise.resolve();
    return new Promise((resolve, reject) => {
        let timer: number | null = null;
        let settled = false;
        let unsubscribe = () => undefined;
        unsubscribe = subscribeSessionBlockMode(blockId, () => {
            if (getSessionBlockMode(blockId) !== "prompt") return;
            settled = true;
            if (timer != null) window.clearTimeout(timer);
            unsubscribe();
            resolve();
        });
        if (settled) return;
        timer = window.setTimeout(() => {
            unsubscribe();
            reject(new Error(`terminal ${blockId} did not reach prompt mode within ${timeoutMs}ms`));
        }, timeoutMs);
    });
}

function waitForCommand(blockId: string, timeoutMs: number): Promise<{ completed: boolean; timedOut: boolean }> {
    return new Promise((resolve) => {
        let leftPrompt = false;
        let timer: number | null = null;
        let settled = false;
        let unsubscribe = () => undefined;
        const finish = (completed: boolean, timedOut: boolean) => {
            if (settled) return;
            settled = true;
            if (timer != null) window.clearTimeout(timer);
            unsubscribe();
            resolve({ completed, timedOut });
        };
        unsubscribe = subscribeSessionBlockMode(blockId, () => {
            const mode = getSessionBlockMode(blockId);
            if (mode !== "prompt") {
                leftPrompt = true;
            } else if (leftPrompt) {
                finish(true, false);
            }
        });
        if (settled) return;
        timer = window.setTimeout(() => finish(false, true), timeoutMs);
    });
}

/**
 * Run from the renderer devtools (or Playwright through CDP). It measures gaps
 * between animation frames while a command is active; it does not claim PTY
 * throughput when the command times out.
 */
export async function runCommandBenchmark(options: CommandBenchmarkOptions): Promise<CommandBenchmarkResult> {
    const timeoutMs = options.timeoutMs ?? 180_000;
    await waitForPrompt(options.blockId, Math.min(timeoutMs, 10_000));
    const refreshFrameTimesMs = await sampleRefreshFrames();

    const slotsBefore = poolSlotStats();
    const heapBeforeBytes = heapBytes();
    const frameTimesMs: number[] = [];
    let lastFrame: number | null = null;
    let sampling = true;
    const sample = (timestamp: number) => {
        if (!sampling) return;
        if (lastFrame != null) frameTimesMs.push(timestamp - lastFrame);
        lastFrame = timestamp;
        requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);

    const startedAt = new Date().toISOString();
    const start = performance.now();
    const completion = waitForCommand(options.blockId, timeoutMs);
    submitToSession(options.blockId, options.command);
    const state = await completion;
    const totalMs = performance.now() - start;
    sampling = false;

    if (state.timedOut && options.interruptOnTimeout !== false) {
        interruptSession(options.blockId);
        await waitForPrompt(options.blockId, 5_000).catch(() => undefined);
    }

    return {
        blockId: options.blockId,
        command: options.command,
        startedAt,
        slotsBefore,
        slotsAfter: poolSlotStats(),
        ...summarizeFrameSamples({
            refreshFrameTimesMs,
            frameTimesMs,
            totalMs,
            heapBeforeBytes,
            heapAfterBytes: heapBytes(),
            ...state,
        }),
    };
}
