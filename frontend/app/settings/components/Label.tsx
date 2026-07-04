// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Label — 11px uppercase muted label used above the card / block sections
// inside the Models tab (Defaults, Providers, Voice input).  Mirrors the
// terax-ai ModelsSection.tsx `Label` helper verbatim so the visual rhythm
// matches when the user A/B-compares the two windows.

import { type ReactNode } from "react";

export function Label({ children }: { children: ReactNode }) {
    return (
        <span className="text-[11px] font-medium tracking-tight text-white/55">{children}</span>
    );
}
