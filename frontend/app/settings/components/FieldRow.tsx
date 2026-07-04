// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// FieldRow — left-rail label + flex-1 control row, the universal building
// block for "key = value" rows inside a setting card.  Mirrors the
// terax-ai ModelsSection.tsx FieldRow verbatim.  16-wide label column gives
// enough room for "Base URL" / "Model ID" / "API key" / "Context" without
// wrapping on the 640px modal content width.

import { type ReactNode } from "react";

type FieldRowProps = {
    label: string;
    children: ReactNode;
};

export function FieldRow({ label, children }: FieldRowProps) {
    return (
        <div className="flex items-center gap-3">
            <span className="w-16 shrink-0 text-[11px] tracking-tight text-white/55">{label}</span>
            <div className="flex flex-1 items-center">{children}</div>
        </div>
    );
}
