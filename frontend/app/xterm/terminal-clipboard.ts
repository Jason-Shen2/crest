// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

function webClipboard(): Clipboard | null {
    if (typeof navigator === "undefined") return null;
    return navigator.clipboard ?? null;
}

export async function readTerminalClipboard(): Promise<string> {
    try {
        return (await webClipboard()?.readText()) ?? "";
    } catch {
        return "";
    }
}

export async function writeTerminalClipboard(text: string): Promise<void> {
    try {
        await webClipboard()?.writeText(text);
    } catch {}
}
