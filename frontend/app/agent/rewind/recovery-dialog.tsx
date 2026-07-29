// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

"use client";

import { Button } from "@/shadcn/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shadcn/ui/dialog";

export interface RecoveryDialogProps {
    open: boolean;
    recovery?: AgentWorkspaceRecoveryView;
    busy: boolean;
    errorMessage?: string;
    onAction: (action: AgentResolveWorkspaceRecoveryInput["action"]) => void;
    onClose: () => void;
}

const RecoveryActionLabels: Record<AgentResolveWorkspaceRecoveryInput["action"], string> = {
    retry: "Retry",
    "abandon-current": "Keep current and abandon operation",
    "quarantine-corrupt": "Quarantine corrupt record and keep current",
};

function recoveryPhaseLabel(phase: AgentWorkspaceRecoveryView["phase"]): string {
    return phase?.replaceAll("_", " ") ?? "diagnostic";
}

export function RecoveryDialog({ open, recovery, busy, errorMessage, onAction, onClose }: RecoveryDialogProps) {
    const allowedActions =
        recovery?.allowedActions.filter((action) => action !== "quarantine-corrupt" || recovery.corrupt) ?? [];

    return (
        <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && !busy && onClose()}>
            <DialogContent showCloseButton={false} className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Workspace recovery required</DialogTitle>
                    <DialogDescription>
                        Agent writes remain frozen until the backend completes or resolves this operation.
                    </DialogDescription>
                </DialogHeader>

                {errorMessage ? (
                    <p className="text-sm text-red-300" role="alert">
                        {errorMessage}
                    </p>
                ) : null}

                {recovery ? (
                    <div className="grid gap-3">
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                            <dt className="text-secondary">Operation</dt>
                            <dd className="break-all font-mono">{recovery.operationId}</dd>
                            <dt className="text-secondary">Phase</dt>
                            <dd className="capitalize">{recoveryPhaseLabel(recovery.phase)}</dd>
                        </dl>
                        <p className="rounded-xl border border-amber-300/25 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
                            {recovery.message}
                        </p>
                        {recovery.paths.length > 0 ? (
                            <ul aria-label="Affected paths" className="grid gap-1.5">
                                {recovery.paths.map((entry) => (
                                    <li
                                        className="flex items-center gap-2 rounded-lg bg-white/[0.035] px-2.5 py-1.5 text-sm"
                                        key={entry.path}
                                    >
                                        <code className="min-w-0 flex-1 break-all">{entry.path}</code>
                                        {entry.classification ? (
                                            <span className="rounded bg-white/[0.07] px-1.5 py-0.5 text-xs text-secondary">
                                                {entry.classification}
                                            </span>
                                        ) : null}
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                    </div>
                ) : (
                    <p className="text-sm text-secondary">Loading authoritative recovery diagnostics…</p>
                )}

                <DialogFooter>
                    <Button className="cursor-pointer" disabled={busy} onClick={onClose} variant="outline">
                        Close
                    </Button>
                    {allowedActions.map((action) => (
                        <Button
                            className="cursor-pointer"
                            disabled={busy}
                            key={action}
                            onClick={() => onAction(action)}
                            variant={action === "retry" ? "default" : "outline"}
                        >
                            {RecoveryActionLabels[action]}
                        </Button>
                    ))}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
