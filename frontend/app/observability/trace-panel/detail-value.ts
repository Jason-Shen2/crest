// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

export interface DetailPreview {
    text: string;
    truncated: boolean;
}

export function serializeDetailValue(value: unknown): string {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export function formatDetailPreview(value: unknown, options: { maxCharacters: number }): DetailPreview {
    const serialized = serializeDetailValue(value);
    if (serialized.length <= options.maxCharacters) {
        return { text: serialized, truncated: false };
    }
    return {
        text: `${serialized.slice(0, options.maxCharacters)}…`,
        truncated: true,
    };
}
