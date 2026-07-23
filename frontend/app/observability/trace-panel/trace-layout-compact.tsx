// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

import { X } from "lucide-react";
import { type ReactNode, useRef } from "react";

export function TraceLayoutCompact({
    navigation,
    detail,
    detailOpen,
    onCloseDetail,
}: {
    navigation: ReactNode;
    detail: ReactNode;
    detailOpen: boolean;
    onCloseDetail: () => void;
}) {
    const navigationRef = useRef<HTMLDivElement>(null);
    const closeDetail = () => {
        onCloseDetail();
        navigationRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    };

    return (
        <div
            data-testid="trace-layout-compact"
            className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-fg-overlay-1/30"
        >
            <div ref={navigationRef} className="min-h-0 min-w-0 flex-1 overflow-hidden">
                {navigation}
            </div>
            {detailOpen ? (
                <section
                    aria-label="Trace detail drawer"
                    className="absolute inset-x-0 bottom-0 z-10 flex max-h-[70%] min-h-48 flex-col border-t border-border bg-panel shadow-xl"
                >
                    <div className="flex h-8 shrink-0 items-center justify-end border-b border-border px-2">
                        <button
                            type="button"
                            aria-label="Close trace detail"
                            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-fg-overlay-1/60 hover:text-foreground"
                            onClick={closeDetail}
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto">{detail}</div>
                </section>
            ) : null}
        </div>
    );
}
