// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type SuggestionType = "path" | "history" | "command" | "argument";

export interface Suggestion {
    display: string; // 菜单展示文本
    replacement: string; // 实际插入文本
    description?: string; // 菜单右侧说明
    type: SuggestionType;
    priority: number; // 排序用，越大越靠前
    icon?: string;
    // 该候选替换的起点 offset；缺省由引擎兜底填充。
    // 这是权威的替换起点，消费方必须使用每个 Suggestion 自身的 spanStart 来计算替换区间。
    spanStart?: number;
}

export interface ReplacementSpan {
    start: number;
    end: number;
}

export interface SuggestionResults {
    // 仅作兜底 / UI 提示；当候选 spanStart 异构（如 history=0、path=token.start）时不可靠，
    // 消费方应改用每个 Suggestion 自身的 spanStart。
    replacementSpan: ReplacementSpan;
    suggestions: Suggestion[];
    // "fuzzy" 预留给未来的模糊匹配，当前仅使用 "prefix"。
    matchStrategy: "prefix" | "fuzzy";
}

export interface DirEntry {
    name: string;
    isDir: boolean;
}

export interface ParsedToken {
    text: string;
    start: number;
    isFirstWord: boolean;
    looksLikePath: boolean;
}

export interface CompletionContext {
    buffer: string;
    cursor: number;
    cwd: string;
    history: string[];
    listDir(path: string): Promise<DirEntry[]>;
}

export type Provider = (
    ctx: CompletionContext,
    token: ParsedToken
) => Promise<Suggestion[]> | Suggestion[];
