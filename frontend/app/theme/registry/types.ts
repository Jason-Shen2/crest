// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Type-level helpers for the theme registry.
//
// The registry is the canonical source-of-truth for bundled crest
// themes.  Each theme file declares either a full TermThemeType payload
// or a PartialTermTheme that inherits any missing fields from a base
// theme (usually `default-dark`).  At consumption time we flatten the
// partial against its base via `resolvePartialTermTheme`, producing a
// payload shape that matches what the Go backend emits from
// pkg/wconfig/defaultconfig/termthemes.json — so the rest of the UI
// doesn't have to special-case "this theme came from a TS file".
//
// TermThemeType is declared as a global type by frontend/types/
// gotypes.d.ts (auto-generated from pkg/wconfig/settingsconfig.go)
// — no import needed.

// A theme that may omit any subset of TermThemeType's fields.  The
// resolver will fill in anything missing from the supplied `base`
// before the result reaches ThemeModel.
//
// Field-by-field Partial<...> would let a theme accidentally wipe out
// things like `display:order`; requiring the id + display name keeps
// the registry sortable in the command palette and discoverable by
// name in logs.
export type PartialTermTheme = {
    /** Required: registry key.  Must match the JSON-side key if a
     *  bundled variant exists in pkg/wconfig/defaultconfig/termthemes.json. */
    id: string;
    /** Required: human label shown in the palette + log lines. */
    "display:name": string;
    /** Optional: smaller sorts first in the palette. */
    "display:order"?: number;
} & Partial<Omit<TermThemeType, "display:name">>;

// UI token overrides — lets a theme specify exact shadcn/ui + sidebar
// color values instead of relying on the blend-formula defaults in
// ThemeModel.computeVars().  Mirrors terax-ai's ThemeColors shape so
// ported themes can use the same hex values verbatim.  All fields are
// optional; any unset token falls through to the formula-computed value.
export type UiThemeOverrides = {
    card?: string;
    cardForeground?: string;
    popover?: string;
    popoverForeground?: string;
    primary?: string;
    primaryForeground?: string;
    secondary?: string;
    secondaryForeground?: string;
    muted?: string;
    mutedForeground?: string;
    accent?: string;
    accentForeground?: string;
    destructive?: string;
    destructiveForeground?: string;
    border?: string;
    input?: string;
    ring?: string;
    sidebar?: string;
    sidebarForeground?: string;
    sidebarPrimary?: string;
    sidebarPrimaryForeground?: string;
    sidebarAccent?: string;
    sidebarAccentForeground?: string;
    sidebarBorder?: string;
    sidebarRing?: string;
};

// A registry entry as exported by an individual theme file.  Each
// theme module exposes one of these so the index can collect them
// without caring whether the underlying payload is full or partial.
export type RegistryEntry = {
    /** Optional base theme key — defaults to "default-dark" when
     *  omitted.  The base must already be resolvable in the registry
     *  index, otherwise we fall back to whatever fullConfig.termthemes
     *  has for that key. */
    extends?: string;
    theme: PartialTermTheme;
    /** Optional exact-value overrides for shadcn/ui + sidebar CSS vars.
     *  When present these win over the blend-formula defaults. */
    ui?: UiThemeOverrides;
};

// A resolved registry entry: the entry plus its computed base.  Returned
// by `getBuiltinThemeEntries()` for callers that want to do the merge
// themselves (e.g.ThemeModel.applyPartialTheme()) instead of taking the
// pre-merged result from getBuiltinThemes().
export type ResolvedRegistryEntry = {
    /** The key the theme is registered under (== entry.theme.id). */
    key: string;
    /** The original registry entry, preserved so callers can introspect
     *  which fields the partial declared. */
    entry: RegistryEntry;
    /** The fully-resolved base, or null if this entry has no base
     *  (i.e. it's a terminal base like default-dark).  Callers can
     *  pass this straight to applyPartialTheme() as the `base` arg. */
    base: TermThemeType | null;
};

// Flatten a partial theme against a fully-resolved base.
//
// The merge treats undefined keys as "inherit from base" and present
// keys (including empty strings) as "override".  This matches the
// convention used by the JSON-side termthemes.json where empty-string
// fields like `cursor: ""` mean "let the runtime pick a fallback" —
// distinct from "this key is missing, fall through to base".
//
// Metadata keys (id / display:name / display:order) are intentionally
// not propagated from base — they describe the partial itself, not the
// colors.  Callers that need the merged id/name should read it from
// the partial's own fields, not from the merge output.
export function resolvePartialTermTheme(
    partial: PartialTermTheme,
    base: TermThemeType,
): TermThemeType {
    const result: TermThemeType = { ...base };
    const overrides = partial as Record<string, unknown>;
    for (const key of Object.keys(overrides)) {
        if (key === "id" || key === "display:name" || key === "display:order") continue;
        const value = overrides[key];
        if (value !== undefined) {
            (result as Record<string, unknown>)[key] = value;
        }
    }
    return result;
}

// Back-compat alias.  Older callers (and the registry's own getBuiltinThemes
// path) used `resolveTermTheme` — keep the export so we don't churn the
// import graph for what's functionally the same function.
export const resolveTermTheme = resolvePartialTermTheme;