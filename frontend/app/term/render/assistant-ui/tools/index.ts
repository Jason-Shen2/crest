// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    makeAssistantToolUI,
    type AssistantToolUI,
    type ToolCallMessagePartComponent,
} from "@assistant-ui/react";

import { FileReadTool, FileReadToolNames } from "./file-read-tool";
import { FileWriteTool, FileWriteToolNames } from "./file-write-tool";
import { ShellTool, ShellToolNames } from "./shell-tool";
import { ToolFallback } from "./tool-fallback";
import { WebTool, WebToolNames } from "./web-tool";

function renderersForNames(names: string[], renderer: ToolCallMessagePartComponent): Record<string, ToolCallMessagePartComponent> {
    return Object.fromEntries(names.map((name) => [name, renderer]));
}

export const assistantToolRenderersByName: Record<string, ToolCallMessagePartComponent> = {
    ...renderersForNames(FileReadToolNames, FileReadTool),
    ...renderersForNames(FileWriteToolNames, FileWriteTool),
    ...renderersForNames(ShellToolNames, ShellTool),
    ...renderersForNames(WebToolNames, WebTool),
};

export const AssistantToolUIs: AssistantToolUI[] = Object.entries(assistantToolRenderersByName).map(([toolName, render]) =>
    makeAssistantToolUI({ toolName, render })
);

export function getAssistantToolRenderer(toolName: string): ToolCallMessagePartComponent | undefined {
    return assistantToolRenderersByName[toolName];
}

export { FileReadTool, FileReadToolNames } from "./file-read-tool";
export { FileWriteTool, FileWriteToolNames } from "./file-write-tool";
export { ShellTool, ShellToolNames } from "./shell-tool";
export { ToolFallback } from "./tool-fallback";
export { WebTool, WebToolNames } from "./web-tool";

export const AssistantToolFallback = ToolFallback;
