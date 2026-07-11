// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

import { ToolFallback } from "./tools/tool-fallback";

export function getCrestToolRenderer(_toolName: string): ToolCallMessagePartComponent {
    return ToolFallback;
}

export function getCrestImageAlt(filename: string | undefined, role: "user" | "assistant"): string {
    if (filename) return filename;
    return role === "user" ? "User image attachment" : "Assistant image attachment";
}
