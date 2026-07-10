// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo } from "react";
import {
    MessagePrimitive,
    useAuiState,
    type ReasoningMessagePartProps,
    type ToolCallMessagePartComponent,
    type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";

import { cn } from "@/util/util";

import { assistantToolRenderersByName, ToolFallback } from "./tools";

export function getCrestToolRenderer(toolName: string): ToolCallMessagePartComponent {
    return assistantToolRenderersByName[toolName] ?? ToolFallback;
}

export const CrestUserMessage = memo(() => {
    return (
        <MessagePrimitive.Root className="flex justify-end py-3" data-testid="crest-user-message">
            <div className="max-w-[85%] rounded-2xl bg-fg-overlay-1/45 px-4 py-2.5 text-sm leading-relaxed text-foreground">
                <MessagePrimitive.Parts>
                    {({ part }) => {
                        if (part.type === "text") return <p className="whitespace-pre-wrap">{part.text}</p>;
                        if (part.type === "image") return <img className="max-w-full rounded-lg" src={part.image} alt="" />;
                        return null;
                    }}
                </MessagePrimitive.Parts>
            </div>
        </MessagePrimitive.Root>
    );
});
CrestUserMessage.displayName = "CrestUserMessage";

export const CrestAssistantMessage = memo(() => {
    return (
        <MessagePrimitive.Root className="flex gap-3 py-4" data-testid="crest-assistant-message">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/20 text-[11px] font-semibold text-accent">
                AI
            </div>
            <div className="min-w-0 flex-1 space-y-2 text-sm leading-relaxed text-foreground">
                <MessagePrimitive.Parts>
                    {({ part }) => {
                        if (part.type === "text") return <CrestMarkdownText />;
                        if (part.type === "reasoning") return <CrestReasoningPart {...part} />;
                        if (part.type === "tool-call") return <CrestToolCallPart {...part} />;
                        if (part.type === "image") return <img className="max-w-full rounded-lg" src={part.image} alt="" />;
                        return null;
                    }}
                </MessagePrimitive.Parts>
            </div>
        </MessagePrimitive.Root>
    );
});
CrestAssistantMessage.displayName = "CrestAssistantMessage";

export const CrestMarkdownText = memo(() => {
    return (
        <MarkdownTextPrimitive
            className={cn(
                "aui-md max-w-none text-sm leading-relaxed",
                "[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
                "[&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-fg-overlay-2 [&_pre]:bg-background [&_pre]:p-3",
                "[&_code]:rounded [&_code]:bg-fg-overlay-1/30 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12px]"
            )}
        />
    );
});
CrestMarkdownText.displayName = "CrestMarkdownText";

export const CrestReasoningPart = memo((props: ReasoningMessagePartProps) => {
    const messageIsRunning = useAuiState((s) => s.message.status?.type === "running");
    const isRunning = messageIsRunning || props.status.type === "running";
    const testId = isRunning ? "crest-reasoning-running" : "crest-reasoning-complete";

    return (
        <details
            className="my-2 rounded-md border border-fg-overlay-2 bg-fg-overlay-1/15 text-xs text-secondary"
            data-testid={testId}
            open={isRunning}
        >
            <summary className="cursor-pointer select-none px-3 py-2 font-medium text-secondary/85">
                {isRunning ? "Thinking..." : "Thought process"}
            </summary>
            <div className="whitespace-pre-wrap border-t border-fg-overlay-2 px-3 py-2 text-secondary/80">{props.text}</div>
        </details>
    );
});
CrestReasoningPart.displayName = "CrestReasoningPart";

export const CrestToolCallPart = memo((props: ToolCallMessagePartProps) => {
    const ToolRenderer = getCrestToolRenderer(props.toolName);
    return <ToolRenderer {...props} />;
});
CrestToolCallPart.displayName = "CrestToolCallPart";
