// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

"use client";

import { DiffViewer } from "@/app/agent/assistant-ui/diff-viewer";
import { Button } from "@/shadcn/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shadcn/ui/dialog";
import { cn } from "@/util/util";

export interface RewindPreviewDialogProps {
    open: boolean;
    operation: "rewind" | "redo";
    phase: "loading" | "ready" | "applying" | "error";
    preview?: AgentRewindPreviewResult;
    errorMessage?: string;
    onCancel: () => void;
    onConfirm: (mode: "normal" | "force-drift") => void;
}

function RewindFileRow({ file }: { file: AgentRewindFileRowView }) {
    const conflict = file.conflict !== "none";
    return (
        <li
            className={cn(
                "rounded-xl border border-white/[0.10] bg-white/[0.035] px-3 py-2",
                conflict && "border-red-400/35 bg-red-500/10"
            )}
        >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span className="rounded bg-white/[0.07] px-1.5 py-0.5 text-xs uppercase text-secondary">
                    {file.operation}
                </span>
                {file.oldPath && <code className="break-all text-secondary line-through">{file.oldPath}</code>}
                <code className="break-all text-foreground">{file.path}</code>
                {file.additions != null && <span className="text-green-400">+{file.additions}</span>}
                {file.deletions != null && <span className="text-red-400">-{file.deletions}</span>}
                <span className="ml-auto text-xs text-secondary">{file.coverage}</span>
            </div>
            {file.reason && (
                <p className={cn("mt-1 text-xs text-secondary", conflict && "text-red-300")}>{file.reason}</p>
            )}
            {file.diff && (
                <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-secondary">Show diff</summary>
                    <DiffViewer patch={file.diff} size="sm" />
                </details>
            )}
        </li>
    );
}

export function RewindPreviewDialog({
    open,
    operation,
    phase,
    preview,
    errorMessage,
    onCancel,
    onConfirm,
}: RewindPreviewDialogProps) {
    const locked = phase === "loading" || phase === "applying";
    const ready = phase === "ready" && !!preview;
    const canRewind = ready && operation === "rewind" && !preview.hardBlocked;
    const canRedo = ready && operation === "redo" && !preview.hardBlocked && !preview.forceRequired;
    const title = operation === "rewind" ? "Preview rewind" : "Preview redo";

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen && !locked) onCancel();
            }}
        >
            <DialogContent showCloseButton={false} className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        {phase === "loading"
                            ? "Preparing an authoritative preview…"
                            : phase === "applying"
                              ? "Applying the confirmed workspace operation…"
                              : preview
                                ? `${preview.messageCount} messages and ${preview.fileCount} files`
                                : "Review the backend result before continuing."}
                    </DialogDescription>
                </DialogHeader>

                {errorMessage && (
                    <p role="alert" className="text-sm text-red-300">
                        {errorMessage}
                    </p>
                )}

                {preview && (
                    <div className="grid gap-3">
                        {preview.targetPrompt && (
                            <blockquote className="rounded-xl border-l-2 border-accent bg-white/[0.035] px-3 py-2 text-sm">
                                {preview.targetPrompt}
                            </blockquote>
                        )}
                        {preview.coverageWarnings.length > 0 && (
                            <ul className="grid gap-1 text-sm text-amber-200">
                                {preview.coverageWarnings.map((warning, index) => (
                                    <li key={index}>{warning}</li>
                                ))}
                            </ul>
                        )}
                        {preview.files.length > 0 && (
                            <ul className="grid gap-2">
                                {preview.files.map((file, index) => (
                                    <RewindFileRow
                                        key={`${file.oldPath ?? ""}\u0000${file.path}\u0000${index}`}
                                        file={file}
                                    />
                                ))}
                            </ul>
                        )}
                    </div>
                )}

                <DialogFooter>
                    <Button className="cursor-pointer" variant="outline" disabled={locked} onClick={onCancel}>
                        Cancel
                    </Button>
                    {canRewind && preview.forceRequired && (
                        <Button
                            className="cursor-pointer"
                            variant="destructive"
                            onClick={() => onConfirm("force-drift")}
                        >
                            Force revert
                        </Button>
                    )}
                    {canRewind && !preview.forceRequired && (
                        <Button className="cursor-pointer" onClick={() => onConfirm("normal")}>
                            Revert
                        </Button>
                    )}
                    {canRedo && (
                        <Button className="cursor-pointer" onClick={() => onConfirm("normal")}>
                            Redo
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
