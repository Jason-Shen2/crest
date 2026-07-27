// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

export interface WorkspaceContentSlotProps {
    active: boolean;
    children: ReactNode;
    testId: string;
}

export function WorkspaceContentSlot({ active, children, testId }: WorkspaceContentSlotProps) {
    return (
        <section
            aria-hidden={!active}
            className="absolute inset-0 h-full w-full"
            data-testid={testId}
            hidden={!active}
            inert={active ? undefined : true}
            style={{ display: active ? "block" : "none" }}
        >
            {children}
        </section>
    );
}
