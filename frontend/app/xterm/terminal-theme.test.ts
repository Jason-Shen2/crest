// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    settings: new Map<string, unknown>(),
}));

vi.mock("@/store/global", () => ({
    getSettingsKeyAtom: (key: string) => key,
    globalStore: { get: (key: string) => mocks.settings.get(key) },
}));

import { getTermFontSize, isTermWebglEnabled, normalizeScrollback, resolveFontFamily } from "./terminal-theme";

beforeEach(() => {
    mocks.settings.clear();
});

describe("normalizeScrollback", () => {
    it("defaults to 2000 for missing or non-numeric values", () => {
        expect(normalizeScrollback(null)).toBe(2000);
        expect(normalizeScrollback(undefined)).toBe(2000);
        expect(normalizeScrollback("lots")).toBe(2000);
        expect(normalizeScrollback(NaN)).toBe(2000);
    });

    it("floors fractional values", () => {
        expect(normalizeScrollback(1234.9)).toBe(1234);
    });

    it("clamps to the 0..50000 range", () => {
        expect(normalizeScrollback(-5)).toBe(0);
        expect(normalizeScrollback(999999)).toBe(50000);
        expect(normalizeScrollback(50000)).toBe(50000);
    });
});

describe("resolveFontFamily", () => {
    it("prefers an explicit family over the setting", () => {
        mocks.settings.set("term:fontfamily", "Menlo");
        expect(resolveFontFamily("Fira Code")).toBe("Fira Code");
    });

    it("falls back to the term:fontfamily setting", () => {
        mocks.settings.set("term:fontfamily", "Menlo");
        expect(resolveFontFamily()).toBe("Menlo");
    });

    it("defaults to Hack when nothing is configured", () => {
        expect(resolveFontFamily()).toBe("Hack");
        expect(resolveFontFamily("   ")).toBe("Hack");
    });
});

describe("getTermFontSize", () => {
    it("reads term:fontsize", () => {
        mocks.settings.set("term:fontsize", 13);
        expect(getTermFontSize()).toBe(13);
    });

    it("defaults to 16 when unset or invalid", () => {
        expect(getTermFontSize()).toBe(16);
        mocks.settings.set("term:fontsize", 0);
        expect(getTermFontSize()).toBe(16);
    });
});

describe("isTermWebglEnabled", () => {
    it("is enabled by default", () => {
        expect(isTermWebglEnabled()).toBe(true);
    });

    it("honors term:disablewebgl", () => {
        mocks.settings.set("term:disablewebgl", true);
        expect(isTermWebglEnabled()).toBe(false);
    });
});
