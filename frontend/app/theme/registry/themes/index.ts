// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Theme registry — the canonical source-of-truth for themes bundled
// with crest.  Each entry below is one file under ./themes/ that
// declares either a full TermThemeType payload or a PartialTermTheme
// that inherits missing fields from its `extends:` base.
//
// At boot, ThemeModel calls `getBuiltinThemes()` to merge these over
// whatever fullConfig.termthemes contains — registry entries win on
// key collision, so the TS files are authoritative for the bundled
// variants.  Themes not yet ported (onedarkpro, dracula, monokai,
// campbell, warmyellow, rosepine, gruvbox-dark) still load from the
// JSON until we get to them.

import { resolvePartialTermTheme, type PartialTermTheme, type RegistryEntry, type ResolvedRegistryEntry, type UiThemeOverrides } from "../types";
import { defaultDarkEntry, defaultDark } from "./default-dark";
import { cyberWaveEntry } from "./cyber-wave";
import { claudeEntry } from "./claude";
import { solarizedLightEntry } from "./solarized-light";

// All registry entries, in display order.  Order matters for the
// command palette's "active theme" labelling and for the build-time
// JSON regen — but the final order at runtime is driven by each
// entry's `display:order` field.
const REGISTRY: RegistryEntry[] = [defaultDarkEntry, claudeEntry, cyberWaveEntry, solarizedLightEntry];

// Lookup by registry id — used internally for `extends:` resolution.
const BY_ID = new Map<string, RegistryEntry>(REGISTRY.map((e) => [e.theme.id, e]));

export function listBuiltinThemeEntries(): RegistryEntry[] {
    return REGISTRY;
}

// Resolve a (possibly partial) registry entry against its declared
// base.  Walks `extends:` until it lands on an entry with no base
// (default-dark is the terminal base — declared as a full payload so
// the walk terminates).  If the walk ever fails (dangling `extends:`)
// we fall back to defaultDark so the UI never crashes on a malformed
// theme file at startup.
function resolveEntry(entry: RegistryEntry): TermThemeType {
    const visited = new Set<string>();
    let current: RegistryEntry | undefined = entry;
    let base: TermThemeType = defaultDark;

    // Walk the inheritance chain to find the terminal base.  Each
    // step flips `current` to its base entry, so the final `base`
    // is the deepest declared full payload in the chain.
    while (current && current.extends) {
        if (visited.has(current.extends)) {
            // Cycle — bail out to defaultDark rather than infinite-loop.
            break;
        }
        visited.add(current.extends);
        const next = BY_ID.get(current.extends);
        if (!next) break;
        base = next.theme as TermThemeType;
        // We want the *full* base payload, so resolve any partial on
        // the way up too.
        if (next !== entry) {
            base = resolvePartialTermTheme(next.theme, base);
        }
        current = next;
    }

    const resolved = resolvePartialTermTheme(entry.theme, base);
    resolved.id = entry.theme.id;
    resolved["display:name"] = entry.theme["display:name"];
    if (entry.theme["display:order"] !== undefined) {
        resolved["display:order"] = entry.theme["display:order"];
    }
    return resolved;
}

// Walk an entry's `extends:` chain and return the fully-resolved base
// payload.  Differs from resolveEntry() in that this returns the BASE
// rather than the merged result — used by getBuiltinThemeEntries() so
// callers (like ThemeModel.applyPartialTheme) can do the final merge
// themselves and surface the base provenance in logs / debugging.
function resolveBaseForEntry(entry: RegistryEntry): TermThemeType | null {
    if (!entry.extends) return null;
    const baseEntry = BY_ID.get(entry.extends);
    if (!baseEntry) return null;
    return resolveEntry(baseEntry);
}

// Merge the registry over an existing termthemes map (typically the
// JSON-side defaultConfig).  Registry entries win on id collision, so
// editing a TS file immediately overrides the JSON variant without
// requiring the user to delete the JSON key.
export function getBuiltinThemes(
    jsonThemes: { [key: string]: TermThemeType } = {},
): { [key: string]: TermThemeType } {
    const result: { [key: string]: TermThemeType } = { ...jsonThemes };
    for (const entry of REGISTRY) {
        result[entry.theme.id] = resolveEntry(entry);
    }
    return result;
}

// Return every registry entry alongside its resolved base.  The
// alternative to getBuiltinThemes() for callers that want to keep
// the partial/base structure visible — ThemeModel.applyPartialTheme()
// takes this shape, and the registry's debug endpoints (if any) can
// surface "this theme extends X" without re-walking the chain.
//
// Terminal-base entries (default-dark) come back with `base: null`
// because they have no parent to inherit from.  Callers that need
// a non-null base for those should fall back to defaultDark.
export function getBuiltinThemeEntries(): ResolvedRegistryEntry[] {
    return REGISTRY.map((entry) => ({
        key: entry.theme.id,
        entry,
        base: resolveBaseForEntry(entry),
    }));
}

// Return the UI token overrides declared by a registry entry, or an
// empty object if the theme has no entry or declares no overrides.
// Used by ThemeModel.applyTheme() to let TS-bundled themes pin exact
// shadcn/ui + sidebar hex values instead of relying on blend-formula
// derivation (which is close but loses the deliberate subtlety of
// hand-tuned palettes like terax-ai's Claude theme).
export function getThemeUiOverrides(id: string): UiThemeOverrides {
    const entry = BY_ID.get(id);
    return entry?.ui ?? {};
}

// Re-export the partial + entry types so consumers can import them
// from a single path.
export type { PartialTermTheme, RegistryEntry, ResolvedRegistryEntry };
export { resolvePartialTermTheme, resolveTermTheme } from "../types";