// Copyright 2026, Command Line Wave Terminal.
// SPDX-License-Identifier: Apache-2.0
//
// makeIcon — the legacy `makeIconClass` analogue, but returning
// JSX (a <Icon> element) instead of a FA className string.
//
// Used by code that still wants a "function returns an icon" shape,
// e.g. `return makeIcon(icon, { className: "text-xs" })`.
//
// Resolution: same as the <Icon name="..."> component.  Names come
// from FA_TO_HUGEICONS via resolveIconName, so callers can pass FA
// style ("xmark", "chevron-right") and get the right Hugeicons glyph.
//
// Why not delete this entirely?
//   Several files used to do `const iconClass = makeIconClass(...)` +
//   later render `<i className={iconClass + " extra-class"} />`.  That
//   pattern is awkward to express with <Icon>'s className prop because
//   the icon name and the surrounding class string live in different
//   scopes.  makeIcon() keeps the call sites readable.

import { type ReactNode } from "react";

import { Icon } from "@/app/icon/Icon";
import { resolveIconName } from "@/app/icon/icon-aliases";

export type MakeIconOpts = {
    /**
     * Tailwind / utility class string forwarded to the inner <svg>.
     * Use this when you want to combine the icon with positioning,
     * color, or spacing classes inline rather than wrapping the
     * result.
     */
    className?: string;

    /**
     * Pixel side length.  Defaults to 14 — matches the rest of
     * crest's UI density.
     */
    size?: number;

    /**
     * Fallback name when `icon` is blank.  Lets callers model "no
     * specific icon → render something generic" cases without
     * re-implementing the conditional at every site.
     */
    defaultIcon?: string;

    /**
     * Apply a spin animation.  Maps to `animate-spin` via Tailwind.
     */
    spin?: boolean;
};

export function makeIcon(icon: string, opts?: MakeIconOpts): ReactNode {
    let name = icon;
    if (!name && opts?.defaultIcon != null) name = opts.defaultIcon;
    if (!name) return null;
    // resolveIconName accepts both FA-style ("chevron-right") and
    // Hugeicons-kebab ("chevron-right" too — same string here) and
    // returns the canonical kebab key.  If the name isn't in the
    // registry at all, <Icon> renders nothing (intentional — config-
    // driven icons shouldn't crash the tree).
    const resolved = resolveIconName(name);
    return (
        <Icon
            name={resolved}
            size={opts?.size ?? 14}
            className={opts?.className}
            spin={opts?.spin ?? false}
        />
    );
}
