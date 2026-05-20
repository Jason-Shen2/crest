// Copyright 2026, Crest contributors. SPDX-License-Identifier: Apache-2.0
//
// ToolUseCard — top-level container for a single agent tool invocation.
// Structure derived from warp:
//   app/src/ai/blocklist/inline_action/inline_action_header.rs   (header)
//   app/src/ai/blocklist/inline_action/requested_command.rs       (cmd body)
//   app/src/ai/blocklist/inline_action/code_diff_view.rs          (diff body)
//   app/src/terminal/view/block/view_impl.rs:655-728              (approval keys)
// Warp is © 2020-2026 Denver Technologies, Inc., MIT licensed.
//
// State machine (mirrors warp's ToolUseCard, see view_impl.rs):
//   pending          → spinner + tool name + desc
//   needs-approval   → approve / deny buttons + Suggestions list +
//                      Cmd↵ accepts / Esc rejects
//   completed        → green check + collapsible body
//   error            → red banner with errormessage
//
// Body dispatch:
//   originalcontent && modifiedcontent  → ToolDiffCard (file edits)
//   toolname starts with "shell_exec"   → ToolCommandCard
//   else                                 → no body (header + citations only)

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { cn } from "@/util/util";
import { memo, useCallback, useEffect, useRef } from "react";

import { CitationChips } from "./citation-chips";
import { ToolActionHeader } from "./tool-action-header";
import { ToolAskCard, ToolAskSummary } from "./tool-ask-card";
import { ToolCommandCard } from "./tool-command-card";
import { ToolDiffCard } from "./tool-diff-card";
import {
    ApprovalDestination,
    AskUserQuestionAnswer,
    AskUserQuestionPayload,
    Citation,
    SuggestedRule,
} from "@/app/store/aitypes";

// Re-export the data shape so sibling components can share one source
// of truth.  Mirrors WaveUIDataTypes.tooluse in aitypes.ts.
export interface WaveUIDataToolUse {
    toolcallid: string;
    toolname: string;
    tooldesc: string;
    status: "pending" | "error" | "completed";
    runts?: number;
    errormessage?: string;
    approval?:
        | "needs-approval"
        | "user-approved"
        | "user-denied"
        | "auto-approved"
        | "timeout";
    blockid?: string;
    blockhidden?: boolean;
    writebackupfilename?: string;
    inputfilename?: string;
    originalcontent?: string;
    modifiedcontent?: string;
    suggestions?: SuggestedRule[];
    citations?: Citation[];
    askquestion?: AskUserQuestionPayload;
    askanswers?: AskUserQuestionAnswer[];
}

export interface ToolUseCardProps {
    tool: WaveUIDataToolUse;
    chatId: string;
    // File citation jump — wired to "scroll to block + line".  Optional;
    // when omitted the chip still renders but does nothing on click.
    onFileJump?: (filename: string, line?: number) => void;
    // Linked-block jump (the headless shell block a shell_exec tool ran
    // against).  Optional in v1.
    onOpenBlock?: (blockId: string) => void;
    // Focus capture — when this card is the "active needs-approval"
    // target, parent sets focused=true so Cmd↵ / Esc keybindings route
    // here.  v1 doesn't manage focus across cards; we just register
    // global listeners while a needs-approval card is mounted.
    focused?: boolean;
}

export const ToolUseCard = memo(
    ({ tool, chatId, onFileJump, onOpenBlock, focused = true }: ToolUseCardProps) => {
        const needsApproval = tool.approval === "needs-approval";
        const isError = tool.status === "error";
        // ask_user_question takes over the card body: its own card
        // component (ToolAskCard) renders the question + options + a
        // dedicated Submit/Cancel pair that posts approval ± answers.
        // We skip the generic ApprovalRow and the default Cmd↵/Esc
        // keybindings below so the two don't collide.
        const isAsk = tool.toolname === "ask_user_question" && tool.askquestion != null;

        const submit = useCallback(
            async (
                approval: "user-approved" | "user-denied",
                suggestion?: SuggestedRule,
                destination?: ApprovalDestination,
                askAnswers?: AskUserQuestionAnswer[]
            ) => {
                try {
                    await RpcApi.WaveAIToolApproveCommand(TabRpcClient, {
                        chatid: chatId,
                        toolcallid: tool.toolcallid,
                        approval,
                        acceptedtoolname: suggestion?.toolname,
                        acceptedcontent: suggestion?.content,
                        accepteddestination: destination,
                        askanswers: askAnswers,
                    });
                } catch (err) {
                    console.error("tool approval rpc failed:", err);
                }
            },
            [chatId, tool.toolcallid]
        );

        // Keybindings: Cmd+Enter accept, Esc reject — mirrors warp
        // ACCEPT_PROMPT_SUGGESTION_KEYBINDING (view_impl.rs:78).  Active
        // only while this card needs approval AND `focused` is true.
        const submitRef = useRef(submit);
        useEffect(() => {
            submitRef.current = submit;
        }, [submit]);
        useEffect(() => {
            if (!needsApproval || !focused || isAsk) return;
            const onKey = (e: KeyboardEvent) => {
                // Don't steal keys from the editor (cmdblock-input) when it
                // has focus — only act when the focused element is the
                // approval card or no input is focused.
                const active = document.activeElement as HTMLElement | null;
                if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable)) {
                    return;
                }
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void submitRef.current("user-approved");
                    return;
                }
                if (e.key === "Escape") {
                    e.preventDefault();
                    void submitRef.current("user-denied");
                    return;
                }
            };
            document.addEventListener("keydown", onKey);
            return () => document.removeEventListener("keydown", onKey);
        }, [needsApproval, focused, isAsk]);

        const hasDiff = !!tool.originalcontent || !!tool.modifiedcontent;
        const isShell = tool.toolname.startsWith("shell_exec");

        return (
            <div
                className={cn(
                    "my-2 rounded border bg-fg-overlay-1/30 px-2.5 py-2",
                    needsApproval
                        ? "border-amber-400/40 bg-amber-500/5"
                        : isError
                            ? "border-rose-500/40 bg-rose-500/5"
                            : "border-fg-overlay-2"
                )}
                data-tool-callid={tool.toolcallid}
                data-tool-status={tool.status}
                data-tool-approval={tool.approval ?? ""}
            >
                <ToolActionHeader tool={tool} />

                {isAsk && tool.askquestion && needsApproval && (
                    <ToolAskCard
                        payload={tool.askquestion}
                        focused={focused && needsApproval}
                        onSubmit={(answers) =>
                            void submit("user-approved", undefined, undefined, answers)
                        }
                        onCancel={() =>
                            void submit("user-denied", undefined, undefined, [])
                        }
                    />
                )}
                {isAsk && tool.askquestion && !needsApproval && (
                    <ToolAskSummary
                        payload={tool.askquestion}
                        answers={tool.askanswers ?? []}
                    />
                )}

                {!isAsk && hasDiff && (
                    <ToolDiffCard
                        original={tool.originalcontent ?? ""}
                        modified={tool.modifiedcontent ?? ""}
                        filename={tool.inputfilename}
                    />
                )}
                {!isAsk && !hasDiff && isShell && (
                    <ToolCommandCard tool={tool} onOpenBlock={onOpenBlock} />
                )}

                {isError && tool.errormessage && (
                    <div className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 font-sans text-[11px] text-rose-300">
                        {tool.errormessage}
                    </div>
                )}

                <CitationChips citations={tool.citations} onFileJump={onFileJump} />

                {needsApproval && !isAsk && (
                    <ApprovalRow
                        suggestions={tool.suggestions}
                        onApprove={(s, d) => void submit("user-approved", s, d)}
                        onDeny={() => void submit("user-denied")}
                    />
                )}
            </div>
        );
    }
);
ToolUseCard.displayName = "ToolUseCard";

// =========================================================================
// ApprovalRow — approve / deny buttons + "remember this" suggestions.
// Warp reference: action_button.rs + Suggestions list in
// inline_action_header.rs.  v1 surfaces buttons only; "Approve and
// Remember" picks the first suggestion + "session" destination (the
// safest default).  Richer per-destination UX (project / user scope) is
// a polish item.
// =========================================================================
interface ApprovalRowProps {
    suggestions?: SuggestedRule[];
    onApprove: (suggestion?: SuggestedRule, destination?: ApprovalDestination) => void;
    onDeny: () => void;
}

const ApprovalRow = memo(({ suggestions, onApprove, onDeny }: ApprovalRowProps) => {
    return (
        <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
                type="button"
                onClick={() => onApprove()}
                className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded bg-[var(--ansi-green)]/85 px-2 py-1 font-sans text-[11px] font-medium text-background transition-colors hover:bg-[var(--ansi-green)]"
            >
                Approve
                <kbd className="ml-1 rounded bg-black/20 px-1 text-[10px]">⌘↵</kbd>
            </button>
            <button
                type="button"
                onClick={onDeny}
                className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded border border-fg-overlay-3 bg-fg-overlay-1/40 px-2 py-1 font-sans text-[11px] font-medium text-foreground/85 transition-colors hover:bg-fg-overlay-2/60"
            >
                Deny
                <kbd className="ml-1 rounded bg-black/20 px-1 text-[10px]">esc</kbd>
            </button>
            {suggestions && suggestions.length > 0 && (
                <div className="ml-1 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wider text-secondary/70">
                        Approve and remember:
                    </span>
                    {suggestions.map((s, idx) => (
                        <button
                            key={`${s.toolname}-${idx}`}
                            type="button"
                            onClick={() => onApprove(s, "session")}
                            title={`Add a session-scoped permission rule for ${s.toolname}`}
                            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded border border-fg-overlay-3 bg-fg-overlay-1/40 px-1.5 py-0.5 font-sans text-[11px] text-foreground/85 transition-colors hover:bg-fg-overlay-2/60"
                        >
                            {s.display}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
});
ApprovalRow.displayName = "ApprovalRow";
