// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// AgentBlockElement — renders one pi run (one user-initiated send +
// every subsequent assistant + toolResult message until the next
// user message). Post-pi-migration: consumes a PiRun directly; no
// Jotai-atom hop, no ai-sdk UIMessagePart shape, no exchangeId
// indirection. The agent block in TerminalModel is just a marker
// holding a runId; this component resolves it to messages via the
// PiRun passed in.
//
// Visual structure unchanged from the previous incarnation: header
// (status icon + label), user prompt chip, assistant content (text
// + tool cards interleaved), optional error footer.

import { UIcon } from "@/app/element/ui-icon";
import type { PiAgentMessage, PiRun, PiRunStatus } from "@/app/store/use-pi-chat";
import { cn } from "@/util/util";
import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { type PiToolCall, type PiToolResultContent, ToolCallCard } from "./tool-call-card";

const HORIZONTAL_PAD_PX = 16;
const VERTICAL_PAD_PX = 12;

export interface AgentBlockElementProps {
    /** The pi run this block visualizes. Sliced by the parent (block-list-element). */
    run: PiRun;
    /** Selected highlight for the timeline (Cmd+↑/↓ block nav). */
    selected?: boolean;
    /** Font size for the body text. */
    fontSize?: number;
    /** Click handler to mark this block as selected. */
    onSelect?: () => void;
}

export const AgentBlockElement = memo(
    ({ run, selected, fontSize = 16, onSelect }: AgentBlockElementProps) => {
        const userText = useMemo(() => extractText(run.userMessage), [run.userMessage]);
        const isStreaming = run.status === "streaming";
        const isError = run.status === "error";

        return (
            <div
                onClick={onSelect}
                className={cn(
                    // Match the shell block's inter-block divider
                    // (block-element.tsx:439, warp draw_border_between_blocks):
                    // a 1px fg-overlay-2 bottom border. No left flag-pole here.
                    "relative border-b border-fg-overlay-2 font-sans",
                    selected && "bg-fg-overlay-1/30",
                )}
                style={{
                    paddingLeft: `${HORIZONTAL_PAD_PX}px`,
                    paddingRight: `${HORIZONTAL_PAD_PX}px`,
                    paddingTop: `${VERTICAL_PAD_PX}px`,
                    paddingBottom: `${VERTICAL_PAD_PX}px`,
                }}
                data-agent-block-runid={run.runId}
                data-agent-status={run.status}
            >
                <AgentBlockHeader status={run.status} />
                <UserMessage text={userText} fontSize={fontSize} />
                <AssistantContent
                    responseMessages={run.responseMessages}
                    streaming={isStreaming}
                    fontSize={fontSize}
                />
                {isError && run.errorMessage && (
                    // Warp's error style (block/view_impl/common.rs:3013): a row
                    // of [red alert icon] + [muted message text], no box / no red
                    // fill. The icon carries the "error" signal; the text is
                    // subdued and wraps to the block width.
                    <div
                        className="mt-2 flex items-start gap-1.5 text-secondary/80"
                        style={{ fontSize: `${fontSize - 1}px` }}
                    >
                        <UIcon
                            name="alert-triangle"
                            size={fontSize}
                            className="mt-0.5 shrink-0 text-rose-400"
                        />
                        <span className="min-w-0 break-words whitespace-pre-wrap">
                            {run.errorMessage.trim()}
                        </span>
                    </div>
                )}
            </div>
        );
    },
);
AgentBlockElement.displayName = "AgentBlockElement";

// =========================================================================
// extractText — concat text parts from a pi AgentMessage.content array.
// =========================================================================
function extractText(message: PiAgentMessage | undefined): string {
    if (!message) return "";
    const parts = message.content;
    if (!parts) return "";
    const out: string[] = [];
    for (const c of parts) {
        if (c.type === "text" && typeof c.text === "string") {
            out.push(c.text);
        }
    }
    return out.join("");
}

// =========================================================================
// AssistantContent — walk the run's response messages in order, render
// text from assistant messages as markdown, render toolCall blocks as
// ToolCallCards paired with their matching toolResult (looked up by
// toolUseId across subsequent toolResult messages).
// =========================================================================
interface AssistantContentProps {
    responseMessages: PiAgentMessage[];
    streaming: boolean;
    fontSize: number;
}

interface PiToolResultLite extends PiToolResultContent {
    toolUseId: string;
}

const AssistantContent = memo(
    ({ responseMessages, streaming, fontSize }: AssistantContentProps) => {
        // Index toolResults by toolUseId for O(1) lookup. Pi places
        // tool results in dedicated messages (role: "toolResult"); each
        // message's content array may carry multiple toolResult entries
        // when the assistant called several tools in one turn.
        const resultsByCallId = useMemo(() => {
            const map = new Map<string, PiToolResultLite>();
            for (const msg of responseMessages) {
                if (msg.role !== "toolResult") continue;
                if (!msg.content) continue;
                const messageToolUseId =
                    typeof msg.toolUseId === "string"
                        ? msg.toolUseId
                        : typeof msg.toolCallId === "string"
                          ? msg.toolCallId
                          : "";
                if (messageToolUseId) {
                    map.set(messageToolUseId, {
                        toolUseId: messageToolUseId,
                        content: msg.content as PiToolResultContent["content"],
                        details: msg.details,
                        isError: msg.isError === true,
                    });
                    continue;
                }
                for (const c of msg.content) {
                    if (c.type !== "toolResult") continue;
                    const toolUseId =
                        typeof c.toolUseId === "string"
                            ? c.toolUseId
                            : typeof c.toolCallId === "string"
                              ? (c.toolCallId as string)
                              : "";
                    if (!toolUseId) continue;
                    map.set(toolUseId, {
                        toolUseId,
                        content: c.content as PiToolResultContent["content"],
                        details: c.details,
                        isError: c.isError === true,
                    });
                }
            }
            return map;
        }, [responseMessages]);

        const rendered: React.ReactNode[] = [];
        let textBuf = "";
        let keyIdx = 0;
        const flushText = () => {
            if (!textBuf) return;
            rendered.push(<AssistantMarkdown key={`text-${keyIdx++}`} text={textBuf} fontSize={fontSize} />);
            textBuf = "";
        };

        for (const msg of responseMessages) {
            if (msg.role !== "assistant" || !msg.content) continue;
            for (const c of msg.content) {
                if (c.type === "text" && typeof c.text === "string") {
                    textBuf += c.text;
                    continue;
                }
                if (c.type === "toolCall") {
                    flushText();
                    const call: PiToolCall = {
                        id: String(c.id ?? ""),
                        name: String(c.name ?? ""),
                        input: c.input != null ? c.input : c.arguments,
                    };
                    const result = resultsByCallId.get(call.id);
                    rendered.push(<ToolCallCard key={`tool-${call.id}`} call={call} result={result} />);
                    continue;
                }
                if (c.type === "thinking" && typeof c.thinking === "string") {
                    flushText();
                    rendered.push(
                        <ThinkingBlock
                            key={`thinking-${keyIdx++}`}
                            text={c.thinking}
                            fontSize={fontSize}
                            emptyText={streaming ? "Thinking..." : "Reasoning content is not available."}
                        />
                    );
                    continue;
                }
                if (c.type === "image") {
                    const src = imageContentSrc(c);
                    if (!src) continue;
                    flushText();
                    rendered.push(<AssistantImage key={`image-${keyIdx++}`} src={src} />);
                    continue;
                }
            }
        }
        flushText();

        return (
            <div>
                {rendered}
                {streaming && rendered.length === 0 && (
                    <div className="text-secondary/70 text-[12px] italic">Thinking…</div>
                )}
                {streaming && (
                    <span
                        aria-hidden
                        className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse bg-foreground/70 align-text-bottom"
                    />
                )}
            </div>
        );
    },
);
AssistantContent.displayName = "AssistantContent";

function imageContentSrc(content: { [field: string]: unknown }): string {
    const data = typeof content.data === "string" ? content.data : "";
    if (!data) return "";
    if (data.startsWith("data:image/")) return data;
    const mimeType = typeof content.mimeType === "string" && content.mimeType ? content.mimeType : "image/png";
    return `data:${mimeType};base64,${data}`;
}

interface ThinkingBlockProps {
    text: string;
    fontSize: number;
    emptyText: string;
}

const ThinkingBlock = memo(({ text, fontSize, emptyText }: ThinkingBlockProps) => {
    const displayText = text.trim() ? text : emptyText;
    return (
        <details className="my-2 rounded border border-fg-overlay-2 bg-fg-overlay-1/25 px-2 py-1.5">
            <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-wide text-secondary/80">
                Thinking
            </summary>
            <div
                className="mt-1.5 whitespace-pre-wrap break-words text-secondary/90"
                style={{ fontSize: `${Math.max(12, fontSize - 1)}px`, lineHeight: 1.45 }}
            >
                {displayText}
            </div>
        </details>
    );
});
ThinkingBlock.displayName = "ThinkingBlock";

const AssistantImage = memo(({ src }: { src: string }) => (
    <img
        src={src}
        alt=""
        className="my-2 max-h-[420px] max-w-full rounded border border-fg-overlay-2 object-contain"
    />
));
AssistantImage.displayName = "AssistantImage";

// =========================================================================
// AssistantMarkdown — render a text chunk through react-markdown.
// =========================================================================
interface AssistantMarkdownProps {
    text: string;
    fontSize: number;
}
const AssistantMarkdown = memo(({ text, fontSize }: AssistantMarkdownProps) => (
    <div
        className="prose prose-invert max-w-none break-words text-foreground/95
            prose-headings:font-semibold prose-headings:text-foreground
            prose-p:my-2 prose-p:leading-snug prose-li:my-0 prose-ol:my-2 prose-ul:my-2
            prose-code:rounded prose-code:bg-fg-overlay-1/60 prose-code:px-1 prose-code:py-[1px]
            prose-pre:my-2 prose-pre:bg-fg-overlay-1/50 prose-pre:p-2"
        style={{ fontSize: `${fontSize}px`, lineHeight: 1.5 }}
    >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
));
AssistantMarkdown.displayName = "AssistantMarkdown";

// =========================================================================
// AgentBlockHeader — status icon + "Agent" label, with a pulsing dot
// while streaming.
// =========================================================================
interface AgentBlockHeaderProps {
    status: PiRunStatus;
}

const AgentBlockHeader = memo(({ status }: AgentBlockHeaderProps) => {
    const { icon, accent, label } = useMemo(() => {
        switch (status) {
            case "streaming":
                return { icon: "stars-01", accent: "text-[var(--ansi-yellow)]", label: "Agent" };
            case "error":
                return { icon: "stars-01", accent: "text-rose-400", label: "Agent" };
            case "done":
            default:
                return { icon: "stars-01", accent: "text-foreground/85", label: "Agent" };
        }
    }, [status]);
    return (
        <div className="mb-1.5 flex items-center gap-1.5">
            <UIcon name={icon} size={13} className={cn("shrink-0", accent)} />
            <span className={cn("text-[11px] font-semibold uppercase tracking-wider", accent)}>
                {label}
            </span>
            {status === "streaming" && (
                <span className="ml-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ansi-yellow)]" />
            )}
        </div>
    );
});
AgentBlockHeader.displayName = "AgentBlockHeader";

// =========================================================================
// UserMessage — chip showing the user's prompt that initiated this run.
// =========================================================================
interface UserMessageProps {
    text: string;
    fontSize: number;
}

const UserMessage = memo(({ text, fontSize }: UserMessageProps) => {
    if (!text) return null;
    return (
        <div
            className="mb-2 inline-block max-w-full rounded border border-fg-overlay-2 bg-fg-overlay-1/40 px-2 py-1 text-foreground/90 whitespace-pre-wrap"
            style={{ fontSize: `${fontSize}px` }}
        >
            {text}
        </div>
    );
});
UserMessage.displayName = "UserMessage";
