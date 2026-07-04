// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Shared toggle switch — minimal pill-style boolean input.

import clsx from "clsx";

type Props = {
    on: boolean;
    onChange: (next: boolean) => void;
    disabled?: boolean;
    ariaLabel?: string;
};

export function Toggle({ on, onChange, disabled, ariaLabel }: Props) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={ariaLabel}
            disabled={disabled}
            className={clsx("toggle-switch", { on })}
            onClick={() => !disabled && onChange(!on)}
        />
    );
}