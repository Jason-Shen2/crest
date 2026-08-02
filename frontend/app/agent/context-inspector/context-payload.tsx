// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { Fragment, type ReactNode, useMemo } from "react";

const LargePayloadCharacterThreshold = 200_000;
const LargePayloadLineThreshold = 5_000;

const JsonTokenPattern =
    /("(?:\\.|[^"\\])*")(?=\s*:)|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}[\],:]/g;

type PayloadText = {
    text: string;
    json: boolean;
};

function serializeContent(content: unknown): PayloadText {
    if (content == null) {
        return { text: "Content unavailable.", json: false };
    }
    if (typeof content === "string") {
        return { text: content, json: false };
    }
    try {
        const text = JSON.stringify(content, null, 2);
        if (text == null) {
            return { text: "Content unavailable.", json: false };
        }
        return { text, json: true };
    } catch {
        return { text: "Content unavailable.", json: false };
    }
}

function exceedsLineThreshold(text: string): boolean {
    let cursor = 0;
    let lineCount = 1;
    while (lineCount <= LargePayloadLineThreshold) {
        const newline = text.indexOf("\n", cursor);
        if (newline < 0) return false;
        cursor = newline + 1;
        lineCount++;
    }
    return true;
}

function jsonTokenTone(token: string, source: string, offset: number): string {
    if (token.startsWith('"')) {
        return /^\s*:/.test(source.slice(offset + token.length)) ? "text-sky-300" : "text-emerald-300";
    }
    if (/^(true|false|null)$/.test(token)) return "text-amber-300";
    if (/^-?\d/.test(token)) return "text-violet-300";
    return "text-slate-400";
}

function JsonLine({ line }: { line: string }) {
    const tokens: ReactNode[] = [];
    let cursor = 0;
    for (const match of line.matchAll(JsonTokenPattern)) {
        const index = match.index ?? 0;
        if (index > cursor) tokens.push(line.slice(cursor, index));
        tokens.push(
            <span
                key={`${index}-${match[0]}`}
                data-testid="context-json-token"
                className={jsonTokenTone(match[0], line, index)}
            >
                {match[0]}
            </span>
        );
        cursor = index + match[0].length;
    }
    if (cursor < line.length) tokens.push(line.slice(cursor));
    return <>{tokens}</>;
}

export function ContextPayload({
    itemId,
    panelId,
    labelledBy,
    content,
}: {
    itemId: string;
    panelId: string;
    labelledBy: string;
    content: unknown;
}) {
    const payload = useMemo(() => {
        const serialized = serializeContent(content);
        const large = serialized.text.length > LargePayloadCharacterThreshold || exceedsLineThreshold(serialized.text);
        return {
            ...serialized,
            large,
            lines: large ? [] : serialized.text.split("\n"),
        };
    }, [content]);

    return (
        <div
            id={panelId}
            role="region"
            aria-labelledby={labelledBy}
            tabIndex={0}
            data-testid={`context-payload-${itemId}`}
            className="max-h-[min(52vh,36rem)] overflow-auto border-t border-border/60 bg-slate-950 text-slate-100 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
            {payload.large ? (
                <pre
                    data-testid="context-payload-large-value"
                    className="m-0 block w-full whitespace-pre px-3 py-2 font-mono text-[11px] leading-5 text-slate-100"
                >
                    <code>{payload.text}</code>
                </pre>
            ) : (
                <pre className="m-0 min-w-max py-2 font-mono text-[11px] leading-5">
                    <code>
                        {payload.lines.map((line, index) => (
                            <Fragment key={index}>
                                <span className="grid min-h-[1lh] grid-cols-[3.5rem_minmax(0,1fr)] px-3">
                                    <span
                                        aria-hidden="true"
                                        data-testid="context-payload-line-number"
                                        className="select-none pr-4 text-right text-slate-600"
                                    >
                                        {index + 1}
                                    </span>
                                    <span
                                        data-testid="context-payload-line-value"
                                        className={cn("whitespace-pre select-text", !line && "min-w-px")}
                                    >
                                        {payload.json ? <JsonLine line={line} /> : line}
                                    </span>
                                </span>
                            </Fragment>
                        ))}
                    </code>
                </pre>
            )}
        </div>
    );
}
