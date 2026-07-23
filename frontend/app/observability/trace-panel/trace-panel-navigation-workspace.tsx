// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

import { type ReactNode } from "react";

import { TraceNavigationHeader } from "./trace-navigation-header";

export function TracePanelNavigationWorkspace({
    children,
    headerAction,
}: {
    children: ReactNode;
    headerAction?: ReactNode;
}) {
    return (
        <div data-testid="trace-navigation-workspace" className="flex h-full min-h-0 min-w-0 flex-col">
            <div className="flex shrink-0 items-stretch border-b border-border">
                <div className="min-w-0 flex-1 [&>div]:border-b-0">
                    <TraceNavigationHeader />
                </div>
                {headerAction}
            </div>
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
        </div>
    );
}
