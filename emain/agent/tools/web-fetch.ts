// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// web_fetch — GET a URL and return its body as text. Uses Node's
// built-in fetch (Node 22+). No browser, no JS execution — just HTTP.
// For pages that need rendering, the future browser tool will own
// that path; web_fetch stays minimal.

import { Type, type Static } from "typebox";

import type { AgentTool } from "../types";

const NAME = "web_fetch";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1_000_000; // 1 MB — keep LLM prompt budget sane.

const WebFetchSchema = Type.Object({
    url: Type.String({ description: "Absolute HTTP/HTTPS URL to GET." }),
    timeoutMs: Type.Optional(
        Type.Number({ description: `Network timeout. Defaults to ${DEFAULT_TIMEOUT_MS}ms.` }),
    ),
});

export interface WebFetchDetails {
    url: string;
    status: number;
    contentType: string;
    bytesReturned: number;
    truncated: boolean;
}

export const webFetchTool: AgentTool<typeof WebFetchSchema, WebFetchDetails> = {
    name: NAME,
    label: "Fetch URL",
    description:
        "HTTP GET a URL and return the body as text. Use for fetching docs, API responses, or small assets — not for full HTML page rendering.",
    promptSnippet: "Fetch a URL over HTTP(S) and return the body as text",
    parameters: WebFetchSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal): Promise<{
        content: [{ type: "text"; text: string }];
        details: WebFetchDetails;
    }> {
        const url = params.url;
        if (!/^https?:\/\//.test(url)) {
            throw new Error(`${NAME}: url must start with http:// or https://; got "${url}"`);
        }
        const timeoutMs = Math.max(1_000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        // Cascade the caller-supplied abort signal so the agent can
        // cancel an in-flight fetch when the user hits abort.
        const onAbort = () => controller.abort();
        signal?.addEventListener("abort", onAbort);
        try {
            const response = await fetch(url, { signal: controller.signal });
            const buf = await response.arrayBuffer();
            const bytes = buf.byteLength;
            const truncated = bytes > MAX_BODY_BYTES;
            const sliceBytes = truncated ? buf.slice(0, MAX_BODY_BYTES) : buf;
            const text = new TextDecoder("utf-8", { fatal: false }).decode(sliceBytes);
            const contentType = response.headers.get("content-type") ?? "";
            const note = truncated
                ? `\n\n[truncated — body was ${bytes} bytes, only the first ${MAX_BODY_BYTES} are shown]`
                : "";
            return {
                content: [
                    {
                        type: "text",
                        text: `HTTP ${response.status} ${response.statusText}\nContent-Type: ${contentType}\n\n${text}${note}`,
                    },
                ],
                details: {
                    url,
                    status: response.status,
                    contentType,
                    bytesReturned: Math.min(bytes, MAX_BODY_BYTES),
                    truncated,
                },
            };
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        }
    },
};

type _Static = Static<typeof WebFetchSchema>;
