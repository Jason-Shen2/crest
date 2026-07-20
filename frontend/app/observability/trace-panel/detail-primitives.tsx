// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

import type { ReactNode } from "react";

export type CopyStatus = "idle" | "success" | "error";

export function DetailSection({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
    return (
        <section role="region" aria-label={label} className="rounded-lg border border-border bg-fg-overlay-1/20">
            <header className="flex min-h-9 items-center justify-between gap-2 border-b border-border px-3 py-2">
                <h3 className="text-xs font-medium">{label}</h3>
                {action}
            </header>
            <div className="p-3">{children}</div>
        </section>
    );
}

export function DetailValue({ text, truncated, testId }: { text: string; truncated: boolean; testId?: string }) {
    return (
        <>
            <pre
                data-testid={testId ?? "detail-value-preview"}
                className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed"
            >
                {text}
            </pre>
            {truncated ? <p className="mt-2 text-[10px] text-muted-foreground">Preview truncated</p> : null}
        </>
    );
}

export function DetailCopyButton({ label, status, onCopy }: { label: string; status: CopyStatus; onCopy: () => void }) {
    return (
        <div className="flex items-center gap-2">
            {status === "idle" ? null : (
                <span
                    role="status"
                    aria-live="polite"
                    className={status === "error" ? "text-[10px] text-red-500" : "text-[10px] text-muted-foreground"}
                >
                    {status === "success" ? "Copied" : "Copy failed"}
                </span>
            )}
            <button
                type="button"
                aria-label={`Copy ${label}`}
                className="cursor-pointer rounded border border-border px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-fg-overlay-2 hover:text-foreground"
                onClick={onCopy}
            >
                Copy
            </button>
        </div>
    );
}
