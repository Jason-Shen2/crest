// Copyright 2026, Crest contributors. SPDX-License-Identifier: Apache-2.0
//
// AgentBlockElement — renders one agent exchange (user message + assistant
// reply) as a block within the terminal timeline.  Structure derived from
// warp:
//   app/src/ai/blocklist/agent_view/agent_view_block.rs
//   app/src/ai/blocklist/agent_view/inline_agent_view_header.rs
// Warp is © 2020-2026 Denver Technologies, Inc., MIT licensed.
//
// Differences from warp port:
//   - Rust → React/TS.  Visual constants use crest Tailwind tokens (not
//     warp's pathfinder_color::ColorU literals) so the block visually
//     matches the rest of the crest UI.
//   - Markdown via react-markdown + remark-gfm (warp uses its own
//     markdown_parser crate).  v1 has no syntax highlighting in code
//     blocks — that lives in P3 Markdown delta phase.
//   - Tool action cards (P0.4) will mount inside this component as
//     inline children between markdown segments.  v1 just renders
//     `assistantText` as one markdown stream.

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import * as jotai from "jotai";
import { useAtomValue } from "jotai";
import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Block } from "../engine";
import { TerminalModel } from "../terminal-model";
import { ToolUseCard, WaveUIDataToolUse } from "./tool-use-card";
import { WaveUIMessagePart } from "@/app/store/aitypes";

// Sentinel atom for components rendered without a model (preview /
// tests).  Stable identity = useAtomValue doesn't trigger re-renders
// when the host doesn't provide a model.
const EmptyPartsAtom = jotai.atom(new Map<string, WaveUIMessagePart[]>());

export interface AgentBlockElementProps {
    block: Block;
    // `revision` from TerminalModel — props bumping forces re-render of
    // the memoized component when the agent payload mutates in place.
    revision: number;
    selected?: boolean;
    fontSize?: number;
    onSelect?: () => void;
    // When provided, AgentBlockElement walks the assistant parts array
    // (text + data-tooluse + ...) and renders tool cards inline.  Falls
    // back to the flat `assistantText` projection on agentPayload when
    // parts are absent (e.g. resync from chatstore, pre-P0.4 callers).
    model?: TerminalModel;
    chatId?: string;
    onFileJump?: (filename: string, line?: number) => void;
    onOpenBlock?: (blockId: string) => void;
}

// Visual constants — mirror the spirit of warp's block padding / spacing.
// Numbers chosen to align with cmdblock-input chrome at the bottom of the
// pane so the timeline reads as one continuous column.
const HORIZONTAL_PAD_PX = 16;
const VERTICAL_PAD_PX = 12;

export const AgentBlockElement = memo(
    ({
        block,
        revision: _revision,
        selected,
        fontSize = 13,
        onSelect,
        model,
        chatId,
        onFileJump,
        onOpenBlock,
    }: AgentBlockElementProps) => {
        const payload = block.agentPayload;
        // Subscribe to parts map at top level so this component re-renders
        // when useChat pushes new parts via applyAgentParts.  Hook must
        // run unconditionally; we resolve the actual parts after the
        // early-return guard.
        const partsMap = useAtomValue(model?.agentPartsAtom ?? EmptyPartsAtom);
        if (!payload) return null;

        const isStreaming = payload.status === "streaming";
        const isError = payload.status === "error";
        const parts = partsMap.get(payload.exchangeId);

        return (
            <div
                onClick={onSelect}
                className={cn(
                    "relative border-b border-fg-overlay-1/40 font-sans",
                    selected && "bg-fg-overlay-1/30"
                )}
                style={{
                    paddingLeft: `${HORIZONTAL_PAD_PX}px`,
                    paddingRight: `${HORIZONTAL_PAD_PX}px`,
                    paddingTop: `${VERTICAL_PAD_PX}px`,
                    paddingBottom: `${VERTICAL_PAD_PX}px`,
                }}
                data-agent-block-id={block.id}
                data-agent-status={payload.status}
            >
                <AgentBlockHeader status={payload.status} createdAt={payload.createdAt} />
                <UserMessage text={payload.userText} fontSize={fontSize} />
                {parts && parts.length > 0 && chatId ? (
                    <AssistantParts
                        parts={parts}
                        streaming={isStreaming}
                        fontSize={fontSize}
                        chatId={chatId}
                        onFileJump={onFileJump}
                        onOpenBlock={onOpenBlock}
                    />
                ) : (
                    <AssistantResponse
                        text={payload.assistantText}
                        streaming={isStreaming}
                        fontSize={fontSize}
                    />
                )}
                {isError && payload.errorMessage && (
                    <div
                        className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-rose-300"
                        style={{ fontSize: `${fontSize - 1}px` }}
                    >
                        Error: {payload.errorMessage}
                    </div>
                )}
            </div>
        );
    }
);
AgentBlockElement.displayName = "AgentBlockElement";

// =========================================================================
// AssistantParts — interleaved render of an assistant message's parts
// array.  Text parts go through the same prose pipeline as the v1
// AssistantResponse; data-tooluse parts render as ToolUseCards inline at
// their position in the array.  Other part types (reasoning, file,
// source-url, etc.) are ignored for v1.
// =========================================================================
interface AssistantPartsProps {
    parts: WaveUIMessagePart[];
    streaming: boolean;
    fontSize: number;
    chatId: string;
    onFileJump?: (filename: string, line?: number) => void;
    onOpenBlock?: (blockId: string) => void;
}

const AssistantParts = memo(
    ({ parts, streaming, fontSize, chatId, onFileJump, onOpenBlock }: AssistantPartsProps) => {
        // Walk parts in order.  Coalesce adjacent text parts into one
        // markdown block so headings / lists / code fences spanning
        // chunks render correctly.
        const rendered: React.ReactNode[] = [];
        let textBuf = "";
        const flushText = (keySuffix: string) => {
            if (!textBuf) return;
            rendered.push(
                <AssistantResponse
                    key={`text-${keySuffix}`}
                    text={textBuf}
                    streaming={false}
                    fontSize={fontSize}
                />
            );
            textBuf = "";
        };
        parts.forEach((p, idx) => {
            if (p.type === "text") {
                textBuf += (p as { text: string }).text;
                return;
            }
            if (p.type === "data-tooluse") {
                flushText(`b${idx}`);
                const tool = (p as { data: WaveUIDataToolUse }).data;
                rendered.push(
                    <ToolUseCard
                        key={`tool-${tool.toolcallid}`}
                        tool={tool}
                        chatId={chatId}
                        onFileJump={onFileJump}
                        onOpenBlock={onOpenBlock}
                    />
                );
                return;
            }
            // Unhandled part types (reasoning, source-url, file, ...) —
            // ignore in v1.  Future work: a dedicated renderer per kind.
        });
        flushText("tail");
        return (
            <div>
                {rendered}
                {streaming && (
                    <span
                        aria-hidden
                        className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse bg-foreground/70 align-text-bottom"
                    />
                )}
            </div>
        );
    }
);
AssistantParts.displayName = "AssistantParts";

// =========================================================================
// AgentBlockHeader — status icon + label.  Mirrors warp's
// `inline_agent_view_header.rs` structure: status icon on the left, label
// in the middle, optional metadata on the right.  v1 keeps it minimal —
// "Agent" label + status indicator.  Per-mode icons (ask/plan/do/bench)
// will come once Mode is threaded through.
// =========================================================================
interface AgentBlockHeaderProps {
    status: "streaming" | "done" | "error";
    createdAt: number;
}

const AgentBlockHeader = memo(({ status, createdAt: _createdAt }: AgentBlockHeaderProps) => {
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
// UserMessage — the user's typed prompt.  Warp renders this as a right-
// aligned chip on a tinted background; crest mirrors that pattern but
// keeps the chip left-aligned to match the cmdblock timeline reading
// direction.
// =========================================================================
interface UserMessageProps {
    text: string;
    fontSize: number;
}

const UserMessage = memo(({ text, fontSize }: UserMessageProps) => {
    if (!text) return null;
    return (
        <div
            className="mb-2 whitespace-pre-wrap break-words rounded border border-fg-overlay-2/50 bg-fg-overlay-1/40 px-2.5 py-1.5 text-foreground/90"
            style={{ fontSize: `${fontSize}px`, lineHeight: 1.45 }}
        >
            {text}
        </div>
    );
});
UserMessage.displayName = "UserMessage";

// =========================================================================
// AssistantResponse — the streaming markdown body.  Wraps react-markdown
// with crest-flavored prose styling (no plugin syntax highlighting in v1).
// While `streaming` is true, render a trailing cursor dot so the user
// sees liveness even if no new tokens have landed for a beat.
//
// react-markdown produces native <p>, <pre>, <code>, <ul>, etc.; we lean
// on Tailwind utility selectors via a wrapping `prose` shim defined
// inline.  Adding the `@tailwindcss/typography` plugin is out of scope
// for v1; for now we hand-style the common tags so output isn't visually
// unstyled.
// =========================================================================
interface AssistantResponseProps {
    text: string;
    streaming: boolean;
    fontSize: number;
}

const AssistantResponse = memo(({ text, streaming, fontSize }: AssistantResponseProps) => {
    if (!text && !streaming) {
        return null;
    }
    return (
        <div
            className={cn(
                // Hand-rolled "prose" — keep it tight; will replace with
                // @tailwindcss/typography when we add the plugin.
                "prose-agent text-foreground/95",
                "[&_p]:my-1.5 [&_p]:leading-relaxed",
                "[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:border [&_pre]:border-fg-overlay-2 [&_pre]:bg-background/60 [&_pre]:p-2",
                "[&_code]:rounded [&_code]:bg-fg-overlay-2/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.92em]",
                "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
                "[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5",
                "[&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5",
                "[&_li]:my-0.5",
                "[&_a]:text-[var(--ansi-blue)] [&_a]:underline",
                "[&_h1]:my-2 [&_h1]:text-[1.15em] [&_h1]:font-semibold",
                "[&_h2]:my-2 [&_h2]:text-[1.08em] [&_h2]:font-semibold",
                "[&_h3]:my-1.5 [&_h3]:text-[1.02em] [&_h3]:font-semibold",
                "[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-fg-overlay-3 [&_blockquote]:pl-3 [&_blockquote]:text-foreground/80",
                "[&_table]:my-2 [&_table]:border-collapse",
                "[&_th]:border [&_th]:border-fg-overlay-2 [&_th]:px-2 [&_th]:py-1 [&_th]:bg-fg-overlay-1/60",
                "[&_td]:border [&_td]:border-fg-overlay-2 [&_td]:px-2 [&_td]:py-1"
            )}
            style={{ fontSize: `${fontSize}px`, lineHeight: 1.5 }}
        >
            {text ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            ) : null}
            {streaming && (
                <span
                    aria-hidden
                    className="ml-0.5 inline-block h-[1em] w-[2px] animate-pulse bg-foreground/70 align-text-bottom"
                />
            )}
        </div>
    );
});
AssistantResponse.displayName = "AssistantResponse";
