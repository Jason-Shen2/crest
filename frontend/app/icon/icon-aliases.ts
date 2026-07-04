// Copyright 2026, Command Line Wave Terminal.
// SPDX-License-Identifier: Apache-2.0
//
// Alias map — translates FA-style icon names to Hugeicons kebab names.
//
// Why this file exists:
//   crest's data layers (mimetypes.json, widgets.json, IconButton decl.icon)
//   were authored against Font Awesome's naming convention.  After moving to
//   Hugeicons, the registry's canonical names are different ("chevron-right"
//   in FA is "chevron-right" in Hugeicons, but "shield" in FA is "shield-01"
//   in Hugeicons, and "xmark-large" has no Hugeicons analog).
//
//   Without an alias map, every IconButton decl would need to be rewritten
//   to use Hugeicons names manually.  The alias map handles the translation
//   automatically: getIconByName() checks here first, so calling
//   `<Icon name="xmark" />` just works.
//
// New code should use the Hugeicons kebab name directly (e.g.
// `<Icon name="shield-01" />`) — the FA-name paths here are kept only so
// legacy data flows continue to render.  Console warns in dev when an FA
// name is used.

import type { IconComponent } from "./icon-registry";

// FA-style alias → Hugeicons kebab name.  Add entries here when a name
// from crest's data layer doesn't directly match a registry key.
//
// Aliases are deliberately loose (multiple FA names → same Hugeicons
// target) so we can be lenient about which FA family a caller used
// (regular/solid/brands all collapse to the monoline Hugeicons pick).
export const FA_TO_HUGEICONS: Record<string, string> = {
    // --- navigation / chevrons ---
    "chevron-right": "chevron-right",
    "chevron-left": "chevron-left",
    "chevron-up": "chevron-up",
    "chevron-down": "chevron-down",
    "arrow-up": "arrow-up",
    "arrow-down": "arrow-down-01",
    "arrow-right": "arrow-right-01",
    "arrow-left": "arrow-left-01",
    "arrow-up-right-from-square": "arrow-up-right-01",
    "arrow-right-arrow-left": "arrow-turn-backward",

    // --- file / folder ---
    "folder": "folder-01",
    "folder-open": "folder-open",
    "folder-plus": "folder-add",
    "file": "file-01",
    "file-circle-plus": "file-plus",
    "file-code": "file-code",
    "file-pen": "file-edit",
    "file-code-02": "file-code",

    // --- ui actions ---
    "magnifying-glass": "search-01",
    "magnifying-glass-plus": "search-add",
    "magnifying-glass-minus": "search-minus",
    "search": "search-01",
    "search-plus": "search-add",
    "code-pull-request": "git-pull-request",
    "pull-request": "git-pull-request",
    "plus": "plus-sign",
    "add": "add-01",
    "xmark": "cancel-01",
    "xmark-large": "cancel-01",
    "times": "cancel-01",
    "close": "cancel-01",
    "check": "tick-02",
    "checkmark": "tick-02",
    "edit": "edit-02",
    "pen": "pen-01",
    "pen-to-square": "edit-02",
    "pencil": "pencil",
    "trash": "trash",
    "trash-can": "trash",
    "rotate-right": "rotate-right-01",
    "rotate": "rotate-right-01",
    "rotate-left": "rotate-right-01",
    "arrows-rotate": "refresh-01",
    "sync": "refresh-01",
    "spinner": "loading-03",
    "circle-notch": "loading-03",
    "gear": "settings-01",
    "cog": "settings-01",
    "cogs": "tools",
    "sliders": "sliders-horizontal",
    "sliders-h": "sliders-horizontal",
    "filter": "sliders-horizontal",
    "expand": "expand",
    "down-left-and-up-right-to-center": "minimize-01",
    "compress": "minimize-01",
    "ellipsis": "more-horizontal",
    "ellipsis-v": "ellipsis-vertical",
    "ellipsis-vertical": "ellipsis-vertical",
    "ellipsis-h": "more-horizontal",
    "check-circle": "checkmark-circle-01",
    "circle-check": "checkmark-circle-01",
    "check-line-circle": "checkmark-circle-01",
    "sort-down": "sort-by-down-01",
    "sort-up": "sort-by-up-01",
    "sort": "unfold-more",
    "copy": "copy",
    "copy-05": "copy",
    "download": "download-01",
    "upload": "upload-01",
    "share": "share-01",
    "share-nodes": "share-01",
    "share-from-square": "share-01",
    "menu": "menu-01",
    "bars": "menu-01",
    "list": "list-view",
    "list-tree": "list-tree",
    "table-columns": "table-columns-split",
    "table-columns-split": "table-columns-split",
    "table-rows": "table-rows-split",
    "table-rows-split": "table-rows-split",
    "grid-2": "grid-2-x2",
    "grip": "drag-01",

    // --- status / feedback ---
    "shield": "shield-01",
    "shield-halved": "shield-01",
    "shield-blank": "shield-01",
    "shield-alt": "shield-01",
    "circle-exclamation": "alert-circle",
    "triangle-exclamation": "alert-02",
    "exclamation-triangle": "alert-02",
    "exclamation-circle": "alert-circle",
    "warning": "alert-02",
    "circle-info": "information-circle",
    "circle-xmark": "cancel-circle",
    "times-circle": "cancel-circle",
    "info-circle": "information-circle",

    // --- content / tools ---
    "code": "code",
    "terminal": "terminal",
    "square-terminal": "terminal",
    "command": "command-line",
    "wrench": "wrench-01",
    "hammer": "hammer",
    "key": "key-01",
    "lock": "lock",
    "globe": "globe-02",
    "globe-02": "globe-02",
    "eye": "eye",
    "sparkles": "sparkles",
    "stars-01": "sparkles",
    "star": "sparkles",
    "asterisk": "asterisk",
    "hashtag": "hashtag",
    "tools": "tools",
    "palette": "color-picker",
    "paint-board": "paint-board",
    "user": "user-group",
    "user-group": "user-group",
    "users": "user-group",
    "house": "home-03",
    "home": "home-03",
    "laptop": "computer",
    "computer": "computer",
    "mobile": "smart-phone-01",
    "mobile-screen": "smart-phone-01",
    "cube": "cube",
    "box": "box",
    "tree": "tree-01",
    "rocket": "rocket-01",

    // --- network / volume ---
    "wifi": "antenna",
    "signal": "antenna",
    "antenna": "antenna",
    "network-wired": "antenna",
    "link": "link-01",
    "link-01": "link-01",
    "link-02": "link-02",
    "link-slash": "link-square-01",
    "link-square": "link-square-01",
    "external-link": "link-square-01",
    "external-link-alt": "link-square-01",
    "up-right-from-square": "arrow-up-right-01",
    "mail": "mail-01",
    "envelope": "mail-01",
    "message": "message-01",
    "comment": "message-01",
    "discord": "discord",
    "github": "github",
    "dev": "code",

    // --- web / browser ---
    "bell": "bell",
    "video": "video-01",
    "book": "book-01",
    "heart": "heart",
    "shopping-bag": "shopping-bag-01",
    "tag": "tag-01",
    "map-pin": "map-pin",

    // --- chart / data ---
    "chart-line": "chart-line-data-02",
    "chart-pie": "pie-chart",
    "pie-chart": "pie-chart",
    "pie": "pie-chart",

    // --- time ---
    "clock": "clock-01",
    "clock-01": "clock-01",
    "clock-loader": "loading-03",

    // --- theme ---
    "sun": "sun-03",
    "moon": "moon-02",
    "lightbulb": "sparkles",

    // --- archive ---
    "archive": "package-01",
    "package": "package-01",

    // --- misc braces used by crest data ---
    "git-branch-02": "git-branch-01",
    "code-branch": "git-branch-01",

    // --- volume (additional) ---
    "volume-xmark": "volume-mute-01",
    "volume-mute": "volume-mute-01",
    "volume-high": "volume-high",
    "volume-off": "volume-mute-01",
    "volume-up": "volume-high",
    "volume-down": "volume-high",
    "bell-slash": "bell-off-01",

    // --- shortcuts / alt names ---
    "star-half": "sparkles",
    "bookmark": "tag-01",
    "question": "alert-circle",
    "question-circle": "information-circle",
    "gear-01": "settings-01",

    // --- onboarding (a couple of one-offs in crest) ---
    "table-columns-3": "table-columns-split",
    "table-cells": "table-columns-split",
    "table-list": "table-rows-split",

    // --- bug / debug ---
    "bug": "bug-01",

    // --- brace-pair/curly/parentheses etc. for prompt building ---
    "braces": "command",
    "curly-braces": "command",

    // --- reg-ex / pattern (used in search.tsx custom icons) ---
    "regex": "command",
    "whole-word": "tag-01",
    "case-sensitive": "command",

    // --- text/build ---
    "type": "command",
    "font": "book-01",

    // --- undetermined ---
    "square": "square",
};

// Strip cr-prefixes (the "regular@" / "solid@" / "brands@" / "custom@"
// prefixes makeIconClass used to accept).  These days the registry has
// just one Hugeicons glyph per concept, so we drop the prefix.
export function stripIconPrefix(icon: string): string {
    if (icon == null) return "";
    const known = ["solid@", "regular@", "brands@", "custom@", "light@", "thin@", "duotone@"];
    for (const p of known) {
        if (icon.startsWith(p)) return icon.slice(p.length);
    }
    return icon;
}

// Heuristic: pull the actual icon-name token out of messy FA strings
// like "fa-solid fa-xmark fa-fw" or "fa fa-brands fa-dev fa-fw".
//
// Returns the first token that looks like an icon name (e.g. "xmark",
// "dev"), with FA-specific class prefixes stripped.  Returns null if
// nothing FA-shaped is found.
export function extractFaName(input: string): string | null {
    if (!input) return null;
    // Modifier tokens to skip — these are FA family/utility classes,
    // never actual icon names.  Listed here (not hard-coded inside
    // the loop) so the "icon-name only" predicate can stay a pure
    // regex check.
    const modifierFaTokens = new Set([
        "fa",
        "fa-solid",
        "fa-regular",
        "fa-brands",
        "fa-sharp",
        "fa-light",
        "fa-thin",
        "fa-duotone",
        "fa-fw",
        "fa-spin",
        "fa-stack",
        "fa-pulse",
        "fa-fade",
        "fa-beat",
    ]);
    const tokens = input.split(/\s+/).filter(Boolean);
    for (const t of tokens) {
        // Strip the `fa-` prefix and check the remainder is a "real"
        // icon name rather than a FA family/utility modifier.
        if (/^fa-[a-z0-9-]+$/.test(t) && !modifierFaTokens.has(t)) {
            return t.slice(3); // strip "fa-"
        }
        // Bare token (no prefix) — accept iff it isn't a known FA
        // family/utility modifier.
        if (/^[a-z][a-z0-9-]+$/.test(t) && !modifierFaTokens.has(t)) {
            return t;
        }
    }
    return null;
}

// Resolve a name (FA-style or Hugeicons-style) to the Hugeicons kebab
// form.  Returns the original input if no alias is found, so callers
// that try `<Icon name="weird-name" />` still get the lookup path.
export function resolveIconName(name: string): string {
    if (!name) return name;
    // First strip prefix annotations like "solid@folder-plus".
    let stripped = stripIconPrefix(name);
    // Then if the name is a multi-class FA string (e.g. "fa-solid
    // fa-xmark"), pull out just the icon identifier.
    if (/\s/.test(stripped) || stripped.startsWith("fa-")) {
        const extracted = extractFaName(stripped);
        if (extracted) stripped = extracted;
    }
    return FA_TO_HUGEICONS[stripped] ?? stripped;
}

// Marked for `import { IconComponent } from "./icon-registry"` reuse —
// we accept this type only to keep the file loose with the registry.
// The actual `getIconByName()` does the resolution and lookup.
export type { IconComponent };
