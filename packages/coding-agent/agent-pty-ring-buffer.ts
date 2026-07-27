// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export interface AgentPtyRingBufferOptions {
    maxBytes: number;
    maxLines: number;
}

export class AgentPtyRingBuffer {
    maxBytes: number;
    maxLines: number;
    private value = "";

    constructor(options: AgentPtyRingBufferOptions) {
        this.maxBytes = Math.max(1, options.maxBytes);
        this.maxLines = Math.max(1, options.maxLines);
    }

    append(text: string): void {
        if (!text) return;
        this.value += text;
        this.trimToLineCap();
        this.trimToByteCap();
    }

    text(): string {
        return this.value;
    }

    lineCount(): number {
        if (!this.value) return 0;
        const lines = this.value.split("\n");
        return this.value.endsWith("\n") ? lines.length - 1 : lines.length;
    }

    byteLength(): number {
        return Buffer.byteLength(this.value, "utf8");
    }

    private trimToLineCap(): void {
        const lines = this.value.split("\n");
        const hasTrailingNewline = this.value.endsWith("\n");
        if (hasTrailingNewline) {
            lines.pop();
        }
        if (lines.length <= this.maxLines) return;
        const kept = lines.slice(-this.maxLines);
        this.value = kept.join("\n") + (hasTrailingNewline ? "\n" : "");
    }

    private trimToByteCap(): void {
        let bytes = Buffer.byteLength(this.value, "utf8");
        if (bytes <= this.maxBytes) return;
        while (this.value && bytes > this.maxBytes) {
            const newlineIndex = this.value.indexOf("\n");
            if (newlineIndex >= 0 && newlineIndex < this.value.length - 1) {
                this.value = this.value.slice(newlineIndex + 1);
            } else {
                this.value = this.value.slice(1);
            }
            bytes = Buffer.byteLength(this.value, "utf8");
        }
    }
}
