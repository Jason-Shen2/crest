// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shared section header — matches terax SectionHeader.tsx (18px title +
// optional 12px muted description).

import { ReactNode } from "react";

type Props = {
    title: string;
    description?: ReactNode;
};

export function SectionHeader({ title, description }: Props) {
    return (
        <div className="section-header">
            <h1 className="section-title">{title}</h1>
            {description ? <p className="section-description">{description}</p> : null}
        </div>
    );
}