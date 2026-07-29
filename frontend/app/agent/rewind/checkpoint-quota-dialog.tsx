// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

"use client";

import { Button } from "@/shadcn/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/shadcn/ui/dialog";
import { useEffect, useId, useRef, useState } from "react";

export interface CheckpointPurgeRequest {
    trashedSessionId: string;
    confirmationToken: string;
}

export interface CheckpointQuotaDialogProps {
    open: boolean;
    owners: AgentCheckpointTrashOwnerView[];
    phase: "idle" | "loading" | "ready" | "purging" | "error";
    errorMessage?: string;
    onClose: () => void;
    onPurge: (request: CheckpointPurgeRequest) => void;
    onRefresh: () => void;
    maintenanceBusy?: boolean;
    mutationsDisabled?: boolean;
    staleOwnerIds?: string[];
}

function bytesLabel(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 ** 2) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    if (bytes < 1024 ** 3) {
        return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
    }
    return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

export function CheckpointQuotaDialog({
    open,
    owners,
    phase,
    errorMessage,
    onClose,
    onPurge,
    onRefresh,
    maintenanceBusy = false,
    mutationsDisabled = false,
    staleOwnerIds = [],
}: CheckpointQuotaDialogProps) {
    const [confirmingOwnerIdentity, setConfirmingOwnerIdentity] = useState<{
        sessionId: string;
        confirmationToken: string;
    }>();
    const busy = maintenanceBusy || phase === "loading" || phase === "purging";
    const confirmingOwner = owners.find((owner) => owner.sessionId === confirmingOwnerIdentity?.sessionId);
    const confirmingOwnerIsCurrent =
        confirmingOwner != null &&
        confirmingOwner.confirmationToken === confirmingOwnerIdentity?.confirmationToken &&
        !staleOwnerIds.includes(confirmingOwner.sessionId);
    const confirmationId = useId();
    const confirmationTitleId = `${confirmationId}-title`;
    const confirmationDescriptionId = `${confirmationId}-description`;
    const confirmButtonRef = useRef<HTMLButtonElement>(null);
    const deleteButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (
            confirmingOwnerIdentity &&
            (!open ||
                !confirmingOwner ||
                confirmingOwner.confirmationToken !== confirmingOwnerIdentity.confirmationToken ||
                staleOwnerIds.includes(confirmingOwnerIdentity.sessionId))
        ) {
            setConfirmingOwnerIdentity(undefined);
            if (open) {
                deleteButtonRef.current?.focus();
            }
        }
    }, [confirmingOwner, confirmingOwnerIdentity, open, staleOwnerIds]);

    useEffect(() => {
        if (confirmingOwnerIsCurrent) {
            confirmButtonRef.current?.focus();
        }
    }, [confirmingOwnerIsCurrent]);

    const cancelConfirmation = (): void => {
        setConfirmingOwnerIdentity(undefined);
        deleteButtonRef.current?.focus();
    };

    return (
        <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && !busy && onClose()}>
            <DialogContent showCloseButton={false} className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Manage checkpoint storage</DialogTitle>
                    <DialogDescription>
                        Only sessions already in Agent session trash can be permanently deleted here.
                    </DialogDescription>
                </DialogHeader>

                {errorMessage ? (
                    <p className="text-sm text-red-300" role="alert">
                        {errorMessage}
                    </p>
                ) : null}

                {phase === "loading" ? <p className="text-sm text-secondary">Loading trash owners…</p> : null}
                {phase !== "loading" && owners.length === 0 ? (
                    <p className="text-sm text-secondary">No trashed sessions currently own checkpoint storage.</p>
                ) : null}
                {owners.length > 0 ? (
                    <ul className="grid gap-2">
                        {owners.map((owner) => {
                            const confirming =
                                confirmingOwnerIsCurrent && confirmingOwnerIdentity?.sessionId === owner.sessionId;
                            const ownerLabel = owner.title ?? owner.sessionId;
                            const stale = staleOwnerIds.includes(owner.sessionId);
                            return (
                                <li
                                    className="grid gap-2 rounded-xl border border-white/[0.10] bg-white/[0.035] px-3 py-2"
                                    key={owner.sessionId}
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm font-medium">
                                                {owner.title ?? owner.sessionId}
                                            </p>
                                            {owner.title ? (
                                                <p className="break-all text-xs text-secondary">{owner.sessionId}</p>
                                            ) : null}
                                            <p className="text-xs text-secondary">
                                                {bytesLabel(owner.referencedBytes)} referenced
                                            </p>
                                            {stale ? (
                                                <p className="text-xs text-red-300">
                                                    Purge status is unknown. Refresh storage diagnostics to get a new
                                                    confirmation token.
                                                </p>
                                            ) : null}
                                        </div>
                                        <Button
                                            aria-controls={confirming ? confirmationId : undefined}
                                            aria-expanded={confirming}
                                            aria-label={`Permanently delete ${ownerLabel}`}
                                            aria-disabled={stale || undefined}
                                            className="cursor-pointer"
                                            disabled={busy || mutationsDisabled}
                                            onClick={(event) => {
                                                if (stale) {
                                                    return;
                                                }
                                                deleteButtonRef.current = event.currentTarget;
                                                setConfirmingOwnerIdentity({
                                                    sessionId: owner.sessionId,
                                                    confirmationToken: owner.confirmationToken,
                                                });
                                            }}
                                            size="sm"
                                            variant="destructive"
                                        >
                                            Permanently delete
                                        </Button>
                                    </div>
                                    {confirming ? (
                                        <div
                                            aria-describedby={confirmationDescriptionId}
                                            aria-labelledby={confirmationTitleId}
                                            className="rounded-lg border border-red-400/30 bg-red-500/10 px-2.5 py-2 text-xs"
                                            id={confirmationId}
                                            onKeyDown={(event) => {
                                                if (event.key !== "Escape" || busy) {
                                                    return;
                                                }
                                                event.preventDefault();
                                                event.stopPropagation();
                                                cancelConfirmation();
                                            }}
                                            role="alertdialog"
                                        >
                                            <p className="font-medium" id={confirmationTitleId}>
                                                Permanently delete {ownerLabel}
                                            </p>
                                            <p className="mt-1" id={confirmationDescriptionId}>
                                                This cannot be undone. The session database will be permanently deleted.
                                            </p>
                                            <div className="mt-2 flex gap-2">
                                                <Button
                                                    className="cursor-pointer"
                                                    disabled={busy}
                                                    onClick={cancelConfirmation}
                                                    size="sm"
                                                    variant="outline"
                                                >
                                                    Cancel
                                                </Button>
                                                <Button
                                                    aria-label={`Confirm permanent deletion of ${ownerLabel}`}
                                                    className="cursor-pointer"
                                                    disabled={busy || mutationsDisabled || stale}
                                                    onClick={() =>
                                                        onPurge({
                                                            trashedSessionId: owner.sessionId,
                                                            confirmationToken: owner.confirmationToken,
                                                        })
                                                    }
                                                    ref={confirmButtonRef}
                                                    size="sm"
                                                    variant="destructive"
                                                >
                                                    Confirm permanent deletion
                                                </Button>
                                            </div>
                                        </div>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ul>
                ) : null}

                <DialogFooter>
                    <Button className="cursor-pointer" disabled={busy} onClick={onRefresh} variant="outline">
                        Refresh storage diagnostics
                    </Button>
                    <Button className="cursor-pointer" disabled={busy} onClick={onClose} variant="outline">
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
