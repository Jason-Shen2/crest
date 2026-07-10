// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { memo, useCallback } from "react";

import { cn } from "@/util/util";

export interface CrestComposerProps {
    modelLabel?: string;
    onOpenModelPicker?: () => void;
}

export const CrestComposer = memo(({ modelLabel = "Pick model", onOpenModelPicker }: CrestComposerProps) => {
    const aui = useAui();
    const isRunning = useAuiState((s) => s.thread.isRunning);
    const composerText = useAuiState((s) => (s.composer.isEditing ? s.composer.text : ""));
    const hasModelPicker = onOpenModelPicker != null;

    const handleStop = useCallback(() => {
        aui.thread().cancelRun();
    }, [aui]);

    return (
        <ComposerPrimitive.Root
            className="border-t border-fg-overlay-2 bg-background/95 px-4 py-3"
            data-testid="crest-composer"
        >
            <div className="mx-auto flex max-w-3xl flex-col gap-2 rounded-2xl border border-fg-overlay-2 bg-fg-overlay-1/20 px-3 py-2 focus-within:border-fg-overlay-3">
                <ComposerPrimitive.Input
                    aria-label="Ask Crest agent"
                    className="max-h-48 min-h-16 w-full resize-none bg-transparent text-sm leading-relaxed text-foreground outline-none placeholder:text-secondary/60"
                    placeholder="Ask Crest agent..."
                    minRows={3}
                    maxRows={8}
                    submitMode="ctrlEnter"
                />
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        aria-label="Change agent model"
                        aria-disabled={!hasModelPicker}
                        disabled={!hasModelPicker}
                        onClick={onOpenModelPicker}
                        className={cn(
                            "h-7 max-w-[220px] truncate rounded px-2 text-xs text-secondary transition-colors",
                            hasModelPicker
                                ? "cursor-pointer hover:bg-fg-overlay-1 hover:text-foreground"
                                : "text-secondary/55"
                        )}
                        title={modelLabel}
                    >
                        {modelLabel}
                    </button>
                    <span className="text-[11px] text-secondary/55">Ctrl+Enter to send · Enter for newline</span>
                    <div className="ml-auto">
                        {isRunning ? (
                            <button
                                type="button"
                                aria-label="Stop agent response"
                                onClick={handleStop}
                                className="h-8 cursor-pointer rounded-full border border-fg-overlay-2 px-3 text-sm text-foreground transition-colors hover:bg-fg-overlay-1"
                            >
                                Stop
                            </button>
                        ) : (
                            <ComposerPrimitive.Send
                                aria-label="Send message"
                                className="h-8 cursor-pointer rounded-full bg-accent/80 px-3 text-sm text-primary transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-45"
                                title={composerText.trim() ? "Send message" : "Type a message to send"}
                            >
                                Send
                            </ComposerPrimitive.Send>
                        )}
                    </div>
                </div>
            </div>
        </ComposerPrimitive.Root>
    );
});
CrestComposer.displayName = "CrestComposer";
