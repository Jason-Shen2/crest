// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shared SettingRow — matches terax SettingRow.tsx (title + description on
// the left, control on the right, rounded-lg border bg-card/60).

import clsx from "clsx";
import { ReactNode } from "react";

type Props = {
    title: ReactNode;
    description?: ReactNode;
    children: ReactNode;
    className?: string;
};

export function SettingRow({ title, description, children, className }: Props) {
    return (
        <div className={clsx("setting-row", className)}>
            <div className="setting-row-meta">
                <span className="setting-row-title">{title}</span>
                {description ? <span className="setting-row-desc">{description}</span> : null}
            </div>
            <div className="setting-row-control">{children}</div>
        </div>
    );
}