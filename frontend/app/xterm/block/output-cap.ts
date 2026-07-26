// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const MaxLines = 300;
const MaxChars = 24_000;
const HeadLines = 60;

// Keeps head + tail so the AI sees both the command start (errors often print
// early) and the final result, without flooding the context with build noise.
export function capAttachOutput(text: string, maxLines = MaxLines, maxChars = MaxChars): string {
    let out = text;
    const lines = out.split("\n");
    if (lines.length > maxLines) {
        const head = lines.slice(0, HeadLines);
        const tail = lines.slice(lines.length - (maxLines - HeadLines));
        const dropped = lines.length - maxLines;
        out = [...head, `[... ${dropped} lines truncated ...]`, ...tail].join("\n");
    }
    if (out.length > maxChars) {
        const head = out.slice(0, Math.floor(maxChars * 0.25));
        const tail = out.slice(out.length - Math.floor(maxChars * 0.75));
        out = `${head}\n[... output truncated ...]\n${tail}`;
    }
    return out;
}
