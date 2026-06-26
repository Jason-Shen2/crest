// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type SuggestionType = "path" | "history" | "command" | "argument";

export interface Suggestion {
    display: string; // 菜单展示文本
    replacement: string; // 实际插入文本
    description?: string; // 菜单右侧说明
    type: SuggestionType;
    priority: number; // 排序用，越大越靠前
    icon?: string;
    spanStart?: number; // 该候选替换的起点 offset；缺省由引擎兜底填充
}

export interface ReplacementSpan {
    start: number;
    end: number;
}

export interface SuggestionResults {
    replacementSpan: ReplacementSpan;
    suggestions: Suggestion[];
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
