// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { EditToolCard, WriteToolCard } from "./tools/file-tool-cards";
import { ToolFallback } from "./tools/tool-fallback";

export function getCrestToolRenderer(
    toolName: string,
    fallback: ToolCallMessagePartComponent = ToolFallback
): ToolCallMessagePartComponent {
    if (toolName === "edit") return EditToolCard;
    if (toolName === "write") return WriteToolCard;
    return fallback;
}

export function getCrestImageAlt(filename: string | undefined, role: "user" | "assistant"): string {
    if (filename) return filename;
    return role === "user" ? "User image attachment" : "Assistant image attachment";
}
