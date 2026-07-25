// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { memo } from "react";

export interface TerminalNotificationProps {
    message: string;
}

export const TerminalNotification = memo(function TerminalNotification({ message }: TerminalNotificationProps) {
    return (
        <div
            role="status"
            aria-live="polite"
            className="pointer-events-none absolute right-3 top-3 max-w-[60%] rounded border border-fg-overlay-2 bg-background/95 px-3 py-2 text-[12px] text-foreground shadow-lg"
        >
            {message}
        </div>
    );
});
