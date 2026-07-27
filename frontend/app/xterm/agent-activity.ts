// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Marks are heartbeat-style: the veto must survive gaps between status
// updates from a busy agent, but a crashed agent must not pin its block's
// renderer slot forever, so a mark decays instead of persisting.
const AgentActiveTimeoutMs = 30 * 1000;

const lastActive = new Map<string, number>();
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
let onExited: ((blockId: string) => void) | null = null;

// Covers shells without an OSC 133 C preexec hook (pwsh): an out-of-band
// agent-activity signal (pi-agent, wired later) reports per-block lifecycle
// so a working agent vetoes hibernation even when the shell never emits C.
export function ensureAgentActivityListener(exited: (blockId: string) => void): void {
    onExited = exited;
}

export function markAgentActive(blockId: string): void {
    lastActive.set(blockId, Date.now());
    armExpiry(blockId);
}

export function markAgentInactive(blockId: string): void {
    clearExpiry(blockId);
    lastActive.delete(blockId);
    onExited?.(blockId);
}

export function isAgentActive(blockId: string): boolean {
    const ts = lastActive.get(blockId);
    if (ts == null) return false;
    return Date.now() - ts < AgentActiveTimeoutMs;
}

function armExpiry(blockId: string): void {
    clearExpiry(blockId);
    const timer = setTimeout(() => {
        expiryTimers.delete(blockId);
        lastActive.delete(blockId);
        onExited?.(blockId);
    }, AgentActiveTimeoutMs);
    expiryTimers.set(blockId, timer);
}

function clearExpiry(blockId: string): void {
    const timer = expiryTimers.get(blockId);
    if (timer == null) return;
    clearTimeout(timer);
    expiryTimers.delete(blockId);
}
