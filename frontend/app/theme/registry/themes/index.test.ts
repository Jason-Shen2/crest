// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Smoke test for the theme registry's partial-inheritance resolver.
// Verifies that:
//   - getBuiltinThemes({}) returns the 3 bundled themes (default-dark,
//     cyber-wave, solarized-light)
//   - cyber-wave inherits default-dark's ANSI palette but overrides
//     the gradient + accent + details
//   - solarized-light inherits default-dark's structural shape but
//     overrides the entire ANSI palette + bg/fg + accent
//   - registry entries win over JSON on key collision (so a future
//     cleanup that removes a JSON entry is safe)
//   - resolvePartialTermTheme preserves undefined-vs-present semantics
//     (empty string override vs inherited base value)
//   - getBuiltinThemeEntries surfaces the base provenance for
//     debugging
//
// Run via:  npx vitest run frontend/app/theme/registry/themes/index.test.ts

import { describe, expect, test } from "vitest";

import { getBuiltinThemeEntries, getBuiltinThemes } from "./index";
import { defaultDark } from "./default-dark";
import { resolvePartialTermTheme, type PartialTermTheme } from "../types";

describe("theme registry", () => {
    test("returns the 3 bundled themes by default", () => {
        const themes = getBuiltinThemes();
        expect(Object.keys(themes).sort()).toEqual([
            "cyber-wave",
            "default-dark",
            "solarized-light",
        ]);
    });

    test("registry entries override JSON on key collision", () => {
        // The JSON-side cyber-wave still has all fields filled in;
        // the registry's partial version inherits everything from
        // default-dark except gradient + accent.  They should be
        // visually identical (or as close as the partial can get),
        // but the registry wins on collision.
        const jsonOnly = getBuiltinThemes({
            "cyber-wave": {
                ...defaultDark,
                id: "shadow-id",
                backgroundTop: "#FFFFFF",
                backgroundBottom: "#FFFFFF",
            } as TermThemeType,
        });
        const cyberWave = jsonOnly["cyber-wave"];
        expect(cyberWave.backgroundTop).toBe("#002733");
        expect(cyberWave.backgroundBottom).toBe("#000F14");
    });

    test("cyber-wave inherits default-dark ANSI palette via partial", () => {
        const themes = getBuiltinThemes();
        const cyberWave = themes["cyber-wave"];
        // Inherited fields — same as default-dark.
        expect(cyberWave.black).toBe(defaultDark.black);
        expect(cyberWave.red).toBe(defaultDark.red);
        expect(cyberWave.brightWhite).toBe(defaultDark.brightWhite);
        // Overridden fields.
        expect(cyberWave.backgroundTop).toBe("#002733");
        expect(cyberWave.backgroundBottom).toBe("#000F14");
        expect(cyberWave.accentLeft).toBe("#007972");
        expect(cyberWave.accentRight).toBe("#7B008F");
        expect(cyberWave.details).toBe("darker");
    });

    test("solarized-light overrides the full ANSI palette", () => {
        const themes = getBuiltinThemes();
        const light = themes["solarized-light"];
        // Canonical Solarized values, not default-dark.
        expect(light.background).toBe("#FDF6E3");
        expect(light.red).toBe("#DC322F");
        expect(light.cyan).toBe("#2AA198");
        expect(light.details).toBe("lighter");
    });

    test("all bundled themes have a display:order for sorting", () => {
        const themes = getBuiltinThemes();
        for (const [key, theme] of Object.entries(themes)) {
            expect(typeof theme["display:order"], `${key} display:order`).toBe("number");
            expect(theme["display:name"], `${key} display:name`).toBeTruthy();
        }
    });
});

describe("resolvePartialTermTheme", () => {
    test("inherits undefined keys from base", () => {
        const partial: PartialTermTheme = {
            id: "tweak-on-default",
            "display:name": "Tweak on Default",
            accent: "#FF00FF",
        };
        const merged = resolvePartialTermTheme(partial, defaultDark);
        // Overridden: the partial's accent wins.
        expect(merged.accent).toBe("#FF00FF");
        // Inherited: the partial didn't declare these, base values stay.
        expect(merged.background).toBe(defaultDark.background);
        expect(merged.foreground).toBe(defaultDark.foreground);
        expect(merged.black).toBe(defaultDark.black);
        expect(merged.red).toBe(defaultDark.red);
    });

    test("preserves empty-string override (does NOT fall through to base)", () => {
        // The JSON-side termthemes.json uses `cursor: ""` and
        // `selectionBackground: ""` as "let the runtime pick a
        // fallback" — distinct from "this key is missing".  The
        // resolver must NOT treat empty-string the same as undefined.
        const baseWithCursor = { ...defaultDark, cursor: "#123456" };
        const partial: PartialTermTheme = {
            id: "no-cursor",
            "display:name": "No Cursor",
            cursor: "",
        };
        const merged = resolvePartialTermTheme(partial, baseWithCursor);
        expect(merged.cursor).toBe("");
    });

    test("does not propagate metadata keys (id / display:name / display:order)", () => {
        // The merge is for COLORS, not metadata.  TermThemeType (the
        // merged result type) doesn't have an `id` field at all — the
        // partial's id is registry metadata used to look the entry up
        // in the index, not part of the color payload downstream
        // consumers care about.  display:name and display:order ARE on
        // TermThemeType (as required fields per gotypes.d.ts) but the
        // merge keeps the base's values for both — overriding them on
        // a color-only merge would be surprising (the partial is
        // about overriding colors, not metadata).
        const partial: PartialTermTheme = {
            id: "solarized-mine",
            "display:name": "Solarized Mine",
            "display:order": 99,
            accent: "#FF0000",
        };
        const merged = resolvePartialTermTheme(partial, defaultDark);
        // Colors come from the merge.
        expect(merged.accent).toBe("#FF0000");
        // display:name / display:order stay from base — partial's
        // metadata isn't propagated.
        expect(merged["display:name"]).toBe(defaultDark["display:name"]);
        expect(merged["display:order"]).toBe(defaultDark["display:order"]);
    });
});

describe("getBuiltinThemeEntries", () => {
    test("exposes the base provenance for each entry", () => {
        const entries = getBuiltinThemeEntries();
        const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
        // default-dark is a terminal base.
        expect(byKey["default-dark"].base).toBeNull();
        // cyber-wave / solarized-light extend default-dark, so their
        // base is the fully-resolved defaultDark.
        expect(byKey["cyber-wave"].base).toEqual(defaultDark);
        expect(byKey["solarized-light"].base).toEqual(defaultDark);
    });

    test("entries can be re-applied with applyPartialTheme to produce the same merged result", () => {
        // Sanity-check the contract: getBuiltinThemeEntries() +
        // resolvePartialTermTheme() should give the same merged theme
        // as getBuiltinThemes() — they're two paths to the same data.
        const entries = getBuiltinThemeEntries();
        const merged = getBuiltinThemes();
        for (const { key, entry, base } of entries) {
            if (base == null) continue; // terminal base, no merge to verify
            const fromEntries = resolvePartialTermTheme(entry.theme, base);
            const fromBuiltin = merged[key];
            expect(fromEntries).toEqual(fromBuiltin);
        }
    });
});