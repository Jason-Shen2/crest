// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { UIcon } from "@/app/element/ui-icon";
import { cn } from "@/util/util";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { formatPromptCwd } from "./cmdblock-status";

export type InputMode = "terminal" | "agent";

export interface CmdBlockInputProps {
    cwd?: string;
    home?: string;
    branch?: string;
    venv?: string;
    nodeVersion?: string;
    mode: InputMode;
    onModeChange: (next: InputMode) => void;
    onSubmit: (text: string, mode: InputMode) => void;
    submitting?: boolean;
    disabled?: boolean;
    // The model name shown in the picker pill (Agent mode only).  Click
    // surfaces a menu — the parent owns the menu since the choice list
    // varies per surface (claude / openai / etc).
    modelName?: string;
    onModelClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
    suggestions?: string[];
    onSuggestionPick?: (suggestion: string) => void;
    placeholder?: string;
}

// Status strip — small text row above the input.  Holds cwd / git branch /
// venv / node so the user can eyeball context without checking the prompt.
const ContextStrip = memo(
    ({
        cwd,
        home,
        branch,
        venv,
        nodeVersion,
    }: Pick<CmdBlockInputProps, "cwd" | "home" | "branch" | "venv" | "nodeVersion">) => {
        const prettyCwd = formatPromptCwd(cwd, home ?? "");
        if (!prettyCwd && !branch && !venv && !nodeVersion) return null;
        return (
            <div className="flex items-center gap-2 px-3 py-1 text-[11px] leading-none text-secondary/80">
                {prettyCwd && (
                    <span className="inline-flex items-center gap-1 truncate" title={cwd}>
                        <UIcon name="terminal" size={11} className="opacity-70" />
                        <span className="truncate">{prettyCwd}</span>
                    </span>
                )}
                {branch && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-[#b8f2c0]">
                        <UIcon name="git-branch-02" size={11} className="opacity-80" />
                        <span className="max-w-[100px] truncate">{branch}</span>
                    </span>
                )}
                {venv && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-sky-300/80">
                        <UIcon name="lightning-02" size={11} />
                        <span>{venv}</span>
                    </span>
                )}
                {nodeVersion && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 text-emerald-300/80">
                        <span className="text-[10px] font-mono">node {nodeVersion}</span>
                    </span>
                )}
            </div>
        );
    }
);
ContextStrip.displayName = "ContextStrip";

// CmdBlockInput — bottom-anchored prompt.  Composition (top → bottom):
//   [context strip — cwd / branch / venv]
//   [mode pill]  [input textarea — autosize, monospace]  [model pill] [send]
//   [suggestions row, only when populated]
export const CmdBlockInput = memo(
    ({
        cwd,
        home,
        branch,
        venv,
        nodeVersion,
        mode,
        onModeChange,
        onSubmit,
        submitting,
        disabled,
        modelName,
        onModelClick,
        suggestions,
        onSuggestionPick,
        placeholder,
    }: CmdBlockInputProps) => {
        const [text, setText] = useState("");
        const textareaRef = useRef<HTMLTextAreaElement>(null);

        const autosize = useCallback(() => {
            const el = textareaRef.current;
            if (!el) return;
            el.style.height = "auto";
            const next = Math.min(el.scrollHeight, 280);
            el.style.height = `${next}px`;
        }, []);

        useEffect(() => {
            autosize();
        }, [text, autosize]);

        const submit = useCallback(() => {
            if (disabled || submitting) return;
            const trimmed = text.replace(/\s+$/g, "");
            if (!trimmed) return;
            onSubmit(trimmed, mode);
            setText("");
        }, [disabled, submitting, text, mode, onSubmit]);

        const handleKeyDown = useCallback(
            (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    submit();
                }
            },
            [submit]
        );

        const placeholderText =
            placeholder ?? (mode === "agent" ? "Ask the agent…" : "Run a command…");

        return (
            <div className="shrink-0 border-t border-fg-overlay-2 bg-panel/85 backdrop-blur-md">
                <ContextStrip cwd={cwd} home={home} branch={branch} venv={venv} nodeVersion={nodeVersion} />
                <div className="flex items-end gap-2 px-3 pb-2 pt-1">
                    {/* Mode toggle pill */}
                    <div className="flex shrink-0 items-stretch overflow-hidden rounded border border-fg-overlay-2 bg-fg-overlay-1 text-[11px]">
                        <button
                            type="button"
                            onClick={() => onModeChange("terminal")}
                            className={cn(
                                "flex h-7 cursor-pointer items-center gap-1 px-2 transition-colors",
                                mode === "terminal"
                                    ? "bg-fg-overlay-3 text-foreground"
                                    : "text-secondary hover:bg-fg-overlay-2 hover:text-foreground"
                            )}
                            title="Run shell commands"
                            aria-pressed={mode === "terminal"}
                        >
                            <UIcon name="terminal-input" size={11} />
                            <span>Terminal</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => onModeChange("agent")}
                            className={cn(
                                "flex h-7 cursor-pointer items-center gap-1 px-2 transition-colors",
                                mode === "agent"
                                    ? "bg-fg-overlay-3 text-foreground"
                                    : "text-secondary hover:bg-fg-overlay-2 hover:text-foreground"
                            )}
                            title="Talk to the AI agent"
                            aria-pressed={mode === "agent"}
                        >
                            <UIcon name="stars-01" size={11} />
                            <span>Agent</span>
                        </button>
                    </div>

                    {/* Textarea */}
                    <div
                        className={cn(
                            "flex min-w-0 flex-1 items-center rounded border border-fg-overlay-2 bg-fg-overlay-1 px-2 py-1",
                            "focus-within:border-fg-overlay-3 transition-colors",
                            disabled && "opacity-60"
                        )}
                    >
                        <textarea
                            ref={textareaRef}
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={placeholderText}
                            disabled={disabled || submitting}
                            rows={1}
                            className="min-h-[20px] w-full resize-none bg-transparent font-mono text-[12px] leading-[20px] text-foreground outline-none placeholder:text-secondary/55"
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            autoComplete="off"
                        />
                    </div>

                    {/* Model picker (agent mode only) */}
                    {mode === "agent" && (
                        <button
                            type="button"
                            onClick={onModelClick}
                            className="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded border border-fg-overlay-2 bg-fg-overlay-1 px-2 text-[11px] text-foreground/85 transition-colors hover:bg-fg-overlay-2"
                            title="Pick model"
                        >
                            <UIcon name="stars-01" size={11} />
                            <span className="max-w-[90px] truncate">{modelName ?? "Default"}</span>
                            <UIcon name="chevron-down" size={9} className="text-secondary" />
                        </button>
                    )}

                    {/* Send button */}
                    <button
                        type="button"
                        onClick={submit}
                        disabled={disabled || submitting || !text.trim()}
                        className={cn(
                            "flex h-7 shrink-0 cursor-pointer items-center justify-center rounded px-2.5 text-[11px] font-medium transition-colors",
                            "bg-accent/80 text-primary hover:bg-accent",
                            "disabled:cursor-not-allowed disabled:bg-fg-overlay-2 disabled:text-secondary/70"
                        )}
                        title={mode === "agent" ? "Send to agent (Enter)" : "Run command (Enter)"}
                    >
                        {submitting ? <UIcon name="clock-loader" size={12} className="animate-spin" /> : null}
                        <span className="ml-1">{mode === "agent" ? "Send" : "Run"}</span>
                    </button>
                </div>

                {/* Suggestions row */}
                {suggestions && suggestions.length > 0 && (
                    <div className="flex items-center gap-1 overflow-x-auto px-3 pb-2">
                        {suggestions.slice(0, 12).map((s, i) => (
                            <button
                                key={i}
                                type="button"
                                onClick={() => onSuggestionPick?.(s)}
                                className="shrink-0 cursor-pointer rounded-full border border-fg-overlay-2 bg-fg-overlay-1 px-2 py-0.5 font-mono text-[10px] text-secondary transition-colors hover:bg-fg-overlay-2 hover:text-foreground"
                                title={s}
                            >
                                {s.length > 60 ? s.slice(0, 57) + "…" : s}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        );
    }
);
CmdBlockInput.displayName = "CmdBlockInput";
