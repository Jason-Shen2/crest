// Copyright 2026, Crest contributors. SPDX-License-Identifier: Apache-2.0
//
// ToolAskCard — multi-choice question card for the ask_user_question
// tool. Structure derived from warp:
//   crates/ai/src/agent/action/mod.rs:610-657 (data shape)
//   app/src/ai/blocklist/inline_action/ask_user_question_view.rs (UX)
// Warp is © 2020-2026 Denver Technologies, Inc., MIT licensed.
//
// Layout (per question):
//   [header chip]  Question text
//   [1] Option label                          ← recommended highlight
//       Optional description
//   [2] Option label
//   [3] Option label
//   [4] Other  ← expands inline input when supportsother
//
// Keyboard:
//   1-9     toggle option (multi-select) or select (single-select)
//   Tab     move focus between questions
//   ⌘↵      submit all answers
//   Esc     cancel (=user-denied, empty answers)

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
    AskUserQuestionAnswer,
    AskUserQuestionItem,
    AskUserQuestionPayload,
} from "@/app/store/aitypes";

interface ToolAskCardProps {
    payload: AskUserQuestionPayload;
    // Called when the user submits a complete set of answers. The
    // parent (tool-use-card.tsx) forwards via WaveAIToolApproveCommand
    // with approval="user-approved" + askanswers.
    onSubmit: (answers: AskUserQuestionAnswer[]) => void;
    // Cancel = user-denied with empty answers. Parent posts approval
    // ="user-denied"; the tool returns an empty result and the agent
    // proceeds without an answer.
    onCancel: () => void;
    focused?: boolean;
}

interface QuestionLocalState {
    // Multi-select: set of picked option labels. Single-select: set of
    // size 0 or 1.
    choices: Set<string>;
    // Free-form text when the user picked "Other".  Cleared when the
    // user re-selects a real option.
    otherText: string;
    // True iff the user has currently picked the Other option.
    otherActive: boolean;
}

function newLocalState(): QuestionLocalState {
    return { choices: new Set(), otherText: "", otherActive: false };
}

export const ToolAskCard = memo(({ payload, onSubmit, onCancel, focused = true }: ToolAskCardProps) => {
    const [state, setState] = useState<Map<string, QuestionLocalState>>(() => {
        const init = new Map<string, QuestionLocalState>();
        for (const q of payload.questions) init.set(q.questionid, newLocalState());
        return init;
    });

    // Active question index for keyboard 1-9 routing.  Starts at 0;
    // user can Tab through questions.
    const [activeIdx, setActiveIdx] = useState(0);

    // Always-fresh refs so the keyboard handler can read current state
    // without retriggering its useEffect on every keystroke.
    const stateRef = useRef(state);
    const activeIdxRef = useRef(activeIdx);
    useEffect(() => {
        stateRef.current = state;
        activeIdxRef.current = activeIdx;
    }, [state, activeIdx]);

    const allAnswered = useMemo(() => {
        for (const q of payload.questions) {
            const local = state.get(q.questionid);
            if (!local) return false;
            const hasOther = local.otherActive && local.otherText.trim().length > 0;
            if (local.choices.size === 0 && !hasOther) return false;
        }
        return true;
    }, [payload.questions, state]);

    const toggleOption = useCallback(
        (qIdx: number, label: string) => {
            const q = payload.questions[qIdx];
            if (!q) return;
            setState((prev) => {
                const next = new Map(prev);
                const cur = next.get(q.questionid) ?? newLocalState();
                const choices = new Set(cur.choices);
                if (q.questiontype.multiselect) {
                    if (choices.has(label)) choices.delete(label);
                    else choices.add(label);
                } else {
                    // single-select: clear and set
                    choices.clear();
                    choices.add(label);
                }
                next.set(q.questionid, { choices, otherText: "", otherActive: false });
                return next;
            });
        },
        [payload.questions]
    );

    const toggleOther = useCallback(
        (qIdx: number) => {
            const q = payload.questions[qIdx];
            if (!q || !q.questiontype.supportsother) return;
            setState((prev) => {
                const next = new Map(prev);
                const cur = next.get(q.questionid) ?? newLocalState();
                next.set(q.questionid, {
                    choices: new Set(),
                    otherText: cur.otherText,
                    otherActive: !cur.otherActive,
                });
                return next;
            });
        },
        [payload.questions]
    );

    const setOtherText = useCallback(
        (qIdx: number, value: string) => {
            const q = payload.questions[qIdx];
            if (!q) return;
            setState((prev) => {
                const next = new Map(prev);
                const cur = next.get(q.questionid) ?? newLocalState();
                next.set(q.questionid, {
                    ...cur,
                    otherText: value,
                    otherActive: true,
                    choices: new Set(), // selecting Other clears real-option picks
                });
                return next;
            });
        },
        [payload.questions]
    );

    const buildAnswers = useCallback((): AskUserQuestionAnswer[] => {
        const out: AskUserQuestionAnswer[] = [];
        for (const q of payload.questions) {
            const local = stateRef.current.get(q.questionid);
            if (!local) continue;
            const ans: AskUserQuestionAnswer = { questionid: q.questionid };
            if (local.otherActive && local.otherText.trim()) {
                ans.othertext = local.otherText.trim();
            } else if (local.choices.size > 0) {
                ans.choices = Array.from(local.choices);
            }
            out.push(ans);
        }
        return out;
    }, [payload.questions]);

    const submit = useCallback(() => {
        onSubmit(buildAnswers());
    }, [onSubmit, buildAnswers]);

    // Keyboard routing.  Only active while the card is focused AND no
    // input element captures the keys (so the "Other" textarea typing
    // doesn't trigger option 1).
    //
    // Divergence from warp: warp's ask_user_question_view uses Ctrl-C
    // for cancel (`ask_user_question_view.rs:759`) because that's the
    // terminal convention.  Crest's card lives inside an Electron
    // (desktop / web-ish) surface where Esc is the universal
    // "dismiss dialog" key, and Ctrl-C is reserved for the surrounding
    // shell.  Decision recorded in docs/warp-agent-improvement-plan.md
    // → "Audit C-class decisions".
    useEffect(() => {
        if (!focused) return;
        const onKey = (e: KeyboardEvent) => {
            const active = document.activeElement as HTMLElement | null;
            const isTyping =
                !!active &&
                (active.tagName === "INPUT" ||
                    active.tagName === "TEXTAREA" ||
                    active.isContentEditable);
            if (e.key === "Escape" && !isTyping) {
                e.preventDefault();
                onCancel();
                return;
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !isTyping) {
                e.preventDefault();
                submit();
                return;
            }
            if (isTyping) return;
            // Number keys 1-9 toggle options in the active question.
            if (e.key >= "1" && e.key <= "9") {
                const optIdx = parseInt(e.key, 10) - 1;
                const q = payload.questions[activeIdxRef.current];
                if (!q) return;
                const opts = q.questiontype.options;
                if (optIdx < opts.length) {
                    e.preventDefault();
                    toggleOption(activeIdxRef.current, opts[optIdx].label);
                } else if (q.questiontype.supportsother && optIdx === opts.length) {
                    e.preventDefault();
                    toggleOther(activeIdxRef.current);
                }
                return;
            }
            // Left/Right arrows move between questions — matches warp's
            // ask_user_question_view.rs:1400-1401 nav binding.
            if (
                (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
                payload.questions.length > 1
            ) {
                e.preventDefault();
                setActiveIdx((cur) => {
                    const step = e.key === "ArrowRight" ? 1 : -1;
                    const n = payload.questions.length;
                    return (cur + step + n) % n;
                });
            }
        };
        document.addEventListener("keydown", onKey);
        return () => document.removeEventListener("keydown", onKey);
    }, [focused, onCancel, submit, toggleOption, toggleOther, payload.questions]);

    return (
        <div className="mt-2 space-y-3">
            {payload.questions.map((q, idx) => (
                <QuestionRow
                    key={q.questionid}
                    question={q}
                    active={idx === activeIdx}
                    local={state.get(q.questionid) ?? newLocalState()}
                    onSelectOption={(label) => toggleOption(idx, label)}
                    onToggleOther={() => toggleOther(idx)}
                    onOtherText={(v) => setOtherText(idx, v)}
                    onFocus={() => setActiveIdx(idx)}
                />
            ))}
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={submit}
                    disabled={!allAnswered}
                    className={cn(
                        "inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 font-sans text-[11px] font-medium transition-colors",
                        allAnswered
                            ? "cursor-pointer bg-[var(--ansi-green)]/85 text-background hover:bg-[var(--ansi-green)]"
                            : "cursor-not-allowed bg-fg-overlay-2/40 text-foreground/40"
                    )}
                >
                    Submit
                    <kbd className="ml-1 rounded bg-black/20 px-1 text-[10px]">⌘↵</kbd>
                </button>
                <button
                    type="button"
                    onClick={onCancel}
                    className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded border border-fg-overlay-3 bg-fg-overlay-1/40 px-2 py-1 font-sans text-[11px] font-medium text-foreground/85 transition-colors hover:bg-fg-overlay-2/60"
                >
                    Cancel
                    <kbd className="ml-1 rounded bg-black/20 px-1 text-[10px]">esc</kbd>
                </button>
                {payload.questions.length > 1 && (
                    <span className="ml-1 font-sans text-[10px] text-secondary/65">
                        ← → to move between questions
                    </span>
                )}
            </div>
        </div>
    );
});
ToolAskCard.displayName = "ToolAskCard";

interface QuestionRowProps {
    question: AskUserQuestionItem;
    active: boolean;
    local: QuestionLocalState;
    onSelectOption: (label: string) => void;
    onToggleOther: () => void;
    onOtherText: (value: string) => void;
    onFocus: () => void;
}

const QuestionRow = memo(
    ({ question, active, local, onSelectOption, onToggleOther, onOtherText, onFocus }: QuestionRowProps) => {
        return (
            <div
                onClick={onFocus}
                className={cn(
                    "rounded border px-2.5 py-2 transition-colors",
                    active
                        ? "border-amber-400/60 bg-amber-500/5"
                        : "border-fg-overlay-2/70 bg-fg-overlay-1/30"
                )}
                data-question-id={question.questionid}
            >
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="font-sans text-[12px] text-foreground/95">{question.question}</span>
                    {question.questiontype.multiselect && (
                        <span className="font-sans text-[10px] text-secondary/65">(multi-select)</span>
                    )}
                </div>
                <div className="space-y-1">
                    {question.questiontype.options.map((opt, optIdx) => {
                        const picked = local.choices.has(opt.label);
                        return (
                            <button
                                key={opt.label}
                                type="button"
                                onClick={() => onSelectOption(opt.label)}
                                className={cn(
                                    "flex w-full cursor-pointer items-start gap-2 rounded border px-2 py-1.5 text-left transition-colors",
                                    picked
                                        ? "border-[var(--ansi-blue)]/70 bg-[var(--ansi-blue)]/15"
                                        : opt.recommended
                                            ? "border-[var(--ansi-green)]/50 bg-[var(--ansi-green)]/5 hover:bg-[var(--ansi-green)]/10"
                                            : "border-fg-overlay-2 bg-background/40 hover:bg-fg-overlay-2/40"
                                )}
                            >
                                <span
                                    className={cn(
                                        "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[10px]",
                                        picked
                                            ? "bg-[var(--ansi-blue)] text-background"
                                            : "bg-fg-overlay-2/60 text-foreground/75"
                                    )}
                                >
                                    {optIdx + 1}
                                </span>
                                <span className="flex-1 font-sans text-[12px]">
                                    <span className="text-foreground/95">{opt.label}</span>
                                    {opt.recommended && (
                                        <span className="ml-1.5 text-[10px] text-[var(--ansi-green)]">★ recommended</span>
                                    )}
                                </span>
                                {picked && (
                                    <UIcon name="check" size={12} className="mt-1 shrink-0 text-[var(--ansi-blue)]" />
                                )}
                            </button>
                        );
                    })}
                    {question.questiontype.supportsother && (
                        <button
                            type="button"
                            onClick={onToggleOther}
                            className={cn(
                                "flex w-full cursor-pointer items-start gap-2 rounded border px-2 py-1.5 text-left transition-colors",
                                local.otherActive
                                    ? "border-[var(--ansi-blue)]/70 bg-[var(--ansi-blue)]/15"
                                    : "border-fg-overlay-2 bg-background/40 hover:bg-fg-overlay-2/40"
                            )}
                        >
                            <span
                                className={cn(
                                    "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded font-mono text-[10px]",
                                    local.otherActive
                                        ? "bg-[var(--ansi-blue)] text-background"
                                        : "bg-fg-overlay-2/60 text-foreground/75"
                                )}
                            >
                                {question.questiontype.options.length + 1}
                            </span>
                            <span className="flex-1 font-sans text-[12px] text-foreground/95">Other</span>
                        </button>
                    )}
                    {question.questiontype.supportsother && local.otherActive && (
                        <textarea
                            value={local.otherText}
                            onChange={(e) => onOtherText(e.target.value)}
                            placeholder="Type your answer…"
                            rows={2}
                            autoFocus
                            className="mt-1 w-full resize-y rounded border border-fg-overlay-3 bg-background/70 px-2 py-1 font-sans text-[12px] text-foreground/95 outline-none focus:border-[var(--ansi-blue)]/70"
                        />
                    )}
                </div>
            </div>
        );
    }
);
QuestionRow.displayName = "QuestionRow";

// =========================================================================
// ToolAskSummary — read-only render of an already-answered ask card.
// Used by tool-use-card.tsx when the tool's approval state has already
// resolved (user-approved with answers, or user-denied with empty
// answers).  Mirrors warp's `render_completed_answers` /
// `render_finished` branches in ask_user_question_view.rs (~lines
// 1251-1310): one row per question, picked options as inline chips,
// "no answer" placeholder when the user denied without picking.
// =========================================================================
interface ToolAskSummaryProps {
    payload: AskUserQuestionPayload;
    answers: AskUserQuestionAnswer[];
}

export const ToolAskSummary = memo(({ payload, answers }: ToolAskSummaryProps) => {
    const byId = new Map<string, AskUserQuestionAnswer>();
    for (const a of answers) byId.set(a.questionid, a);
    return (
        <div className="mt-2 space-y-1.5">
            {payload.questions.map((q) => {
                const a = byId.get(q.questionid);
                const hasChoices = !!a?.choices && a.choices.length > 0;
                const hasOther = !!a?.othertext;
                return (
                    <div
                        key={q.questionid}
                        className="rounded border border-fg-overlay-2/70 bg-fg-overlay-1/30 px-2.5 py-1.5"
                        data-question-id={q.questionid}
                    >
                        <div className="font-sans text-[12px] text-foreground/85">{q.question}</div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {hasChoices &&
                                a!.choices!.map((c) => (
                                    <span
                                        key={c}
                                        className="inline-flex items-center gap-1 rounded bg-[var(--ansi-blue)]/15 px-1.5 py-0.5 font-sans text-[11px] text-foreground/95"
                                    >
                                        <UIcon name="check" size={10} className="text-[var(--ansi-blue)]" />
                                        {c}
                                    </span>
                                ))}
                            {hasOther && (
                                <span className="inline-flex items-center gap-1 rounded border border-fg-overlay-3 bg-background/40 px-1.5 py-0.5 font-sans text-[11px] italic text-foreground/85">
                                    <UIcon name="edit-03" size={10} className="text-secondary/75" />
                                    {a!.othertext}
                                </span>
                            )}
                            {!hasChoices && !hasOther && (
                                <span className="font-sans text-[11px] italic text-secondary/65">
                                    (no answer)
                                </span>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
});
ToolAskSummary.displayName = "ToolAskSummary";
