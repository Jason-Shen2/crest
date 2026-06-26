// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ParsedToken } from "./types";

export function parseToken(buffer: string, cursor: number): ParsedToken {
    const left = buffer.slice(0, cursor);
    const m = /(\S*)$/.exec(left);
    const text = m ? m[1] : "";
    const start = cursor - text.length;
    const head = buffer.slice(0, start);
    const isFirstWord = head.trim().length === 0;
    const looksLikePath = text.includes("/") || /^(\.\/|\.\.\/|~)/.test(text);
    return { text, start, isFirstWord, looksLikePath };
}

export function longestCommonPrefix(values: string[]): string {
    if (values.length === 0) return "";
    let prefix = values[0];
    for (const v of values.slice(1)) {
        let i = 0;
        while (i < prefix.length && i < v.length && prefix[i] === v[i]) i++;
        prefix = prefix.slice(0, i);
        if (prefix === "") break;
    }
    return prefix;
}
