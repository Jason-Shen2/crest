// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Smoke test for the icon registry + Icon component.  Verifies:
//   - The registry has a meaningful number of entries (>= 80)
//   - Every registered name resolves to a non-null icon component
//   - listRegisteredIconNames() returns a sorted, unique list
//   - getIconByName() returns null for unknown names
//   - The Icon component renders a HugeiconsIcon for known names
//   - The Icon component renders null for unknown names
//   - The Icon component spreads className / size / strokeWidth
//
// Run via:  npx vitest run frontend/app/icon/icon-registry.test.ts

import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { getIconByName, listRegisteredIconNames } from "./icon-registry";
import { Icon } from "./Icon";

describe("icon-registry", () => {
    test("has at least 80 entries", () => {
        const names = listRegisteredIconNames();
        expect(names.length).toBeGreaterThanOrEqual(80);
    });

    test("every registered name resolves to a non-null icon", () => {
        for (const name of listRegisteredIconNames()) {
            const icon = getIconByName(name);
            expect(icon, `icon for ${name}`).not.toBeNull();
            expect(Array.isArray(icon), `icon for ${name} should be an array`).toBe(true);
        }
    });

    test("listRegisteredIconNames returns sorted, unique entries", () => {
        const names = listRegisteredIconNames();
        const sorted = [...names].sort();
        expect(names).toEqual(sorted);
        const unique = new Set(names);
        expect(unique.size).toBe(names.length);
    });

    test("getIconByName returns null for unknown names", () => {
        expect(getIconByName("not-a-real-icon")).toBeNull();
        expect(getIconByName("")).toBeNull();
        // FA-style names are accepted (auto-resolved via
        // icon-aliases.ts) and hugeicons kebab names resolve directly.
        expect(getIconByName("fa-chevron-down")).not.toBeNull();
        // Mixed multi-class FA strings (e.g. `fa-solid fa-xmark`)
        // also resolve via extractFaName.
        expect(getIconByName("fa-solid fa-xmark")).not.toBeNull();
    });
});

describe("Icon component", () => {
    test("renders a HugeiconsIcon for a known name", () => {
        const html = renderToStaticMarkup(<Icon name="arrow-down-01" />);
        // Hugeicons renders an <svg> with a <path> child.  We don't
        // pin the exact markup — we just verify an svg is emitted.
        expect(html).toContain("<svg");
        expect(html).toContain("<path");
        // Default size is 14; Hugeicons emits it as width/height.
        expect(html).toContain('width="14"');
    });

    test("respects size + strokeWidth overrides", () => {
        const html = renderToStaticMarkup(<Icon name="search-01" size={20} strokeWidth={2.5} />);
        expect(html).toContain('width="20"');
        expect(html).toContain('stroke-width="2.5"');
    });

    test("passes className through", () => {
        const html = renderToStaticMarkup(<Icon name="bell" className="text-muted align-middle" />);
        expect(html).toContain("text-muted");
        expect(html).toContain("align-middle");
    });

    test("renders null for unknown names (no crash)", () => {
        const html = renderToStaticMarkup(<Icon name="nonexistent-icon" />);
        expect(html).toBe("");
    });

    test("decorative by default (aria-hidden)", () => {
        const html = renderToStaticMarkup(<Icon name="arrow-down-01" />);
        expect(html).toContain('aria-hidden="true"');
    });

    test("labelled when title is given", () => {
        const html = renderToStaticMarkup(<Icon name="search-01" title="Search" />);
        expect(html).toContain('role="img"');
        expect(html).toContain('aria-label="Search"');
    });
});