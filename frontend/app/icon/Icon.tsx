// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Icon — the single React component for rendering Hugeicons in crest.
//
// Usage:
//   <Icon name="arrow-down-01" size={12} />
//   <Icon name="search-01" strokeWidth={2} className="text-muted" />
//   <Icon name="bell" />  ←  size defaults to 14
//
// Why a wrapper around <HugeiconsIcon> instead of using HugeiconsIcon
// directly:
//   - Hides the registry lookup, so callers don't have to know about
//     the icon-registry module.
//   - Gives a string-based API (`name="..."`) that matches how icons
//     are referenced in data layers (mimetypes.json, settings, widget
//     metadata).  When those strings flow into JSX, the Icon component
//     does the translation.
//   - Centralizes defaults (size, strokeWidth, currentColor) so the
//     whole app uses the same line weight without per-call repetition.
//
// Known unknown: the component renders nothing when the name isn't in
// the registry.  This is intentional — user-editable config can
// contain stale or hand-typed names, and we want a missing icon to
// show as blank space, not crash the tree.

import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { type CSSProperties } from "react";

import { getIconByName, type IconComponent, type RegisteredIconName } from "./icon-registry";

export type IconName = RegisteredIconName | (string & {});

export type IconProps = {
    /**
     * Kebab-case Hugeicons name.  Lookups go through icon-registry.
     * Unknown names render nothing (see file header for rationale).
     */
    name: IconName;

    /**
     * SVG side length in pixels.  Defaults to 14 — matches crest's
     * existing tight UI density (most FA usages were text-xs /
     * text-sm, which is 12–14px).
     */
    size?: number;

    /**
     * Stroke width.  Defaults to 1.5 — terax uses 1.5 for most icons
     * (we tried 1.75, it felt too thin at 12px).  Use 2 for icons that
     * need to read at small sizes (toolbar buttons).
     */
    strokeWidth?: number;

    /**
     * Pass-through for positioning.  `align-middle` is recommended for
     * icons next to text — without it the icon's baseline sits below
     * the text baseline, which causes a slight vertical offset that
     * reads as "off" in tight layouts.
     */
    className?: string;

    /**
     * Pass-through for any CSS property Hugeicons doesn't expose
     * directly.  Rarely needed — color comes from `currentColor` on
     * the SVG paths, so `text-*` Tailwind classes on the parent
     * control the icon's color.
     */
    style?: CSSProperties;

    /**
     * Title for screen readers.  Icons are decorative by default
     * (aria-hidden); set this to give the icon a label.
     */
    title?: string;

    /**
     * Apply a spin animation (loading/refresh icons).  Equivalent to
     * adding `animate-spin` via Tailwind — kept as a dedicated prop so
     * callers don't have to know the Tailwind class name.  The
     * animation keyframes (`@keyframes spin`) ship in Tailwind by
     * default; if you've customized the theme away, see
     * tailwindsetup.css.
     */
    spin?: boolean;
};

// `IconSvgElement` from @hugeicons/react is structurally the same as
// our local `IconComponent`, so we can pass the result of
// getIconByName() straight into HugeiconsIcon.  The cast is needed
// because the readonly tuple shapes differ slightly (one uses
// `readonly [string, ...]`, the other `[string, ...]`).
function asHugeIcon(icon: IconComponent): IconSvgElement {
    return icon as unknown as IconSvgElement;
}

export function Icon({ name, size = 14, strokeWidth = 1.5, className, style, title, spin }: IconProps) {
    const icon = getIconByName(name);
    if (icon == null) {
        if (process.env.NODE_ENV !== "production") {
            // eslint-disable-next-line no-console
            console.warn(`[Icon] unknown icon name: "${name}"`);
        }
        return null;
    }
    // aria-hidden when decorative; labelled by `title` when one is given.
    const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": true };
    const finalClassName = [className, spin ? "animate-spin" : null].filter(Boolean).join(" ") || undefined;
    return (
        <HugeiconsIcon
            icon={asHugeIcon(icon)}
            size={size}
            strokeWidth={strokeWidth}
            className={finalClassName}
            style={style}
            {...a11y}
        />
    );
}