// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { formatDetailPreview, serializeDetailValue } from "./detail-value";

describe("detail value formatting", () => {
    it.each([
        ["zero", 0, "0"],
        ["false", false, "false"],
        ["empty string", "", ""],
    ])("serializes %s without treating it as empty", (_, value, expected) => {
        expect(serializeDetailValue(value)).toBe(expected);
        expect(formatDetailPreview(value, { maxCharacters: 100, maxTraversalNodes: 10 })).toEqual({
            text: expected,
            truncated: false,
        });
    });

    it("pretty prints structured values", () => {
        expect(serializeDetailValue({ ok: true })).toBe('{\n  "ok": true\n}');
    });

    it("bounds preview serialization without changing the copied value", () => {
        const value = { output: "x".repeat(20_000) };
        const preview = formatDetailPreview(value, { maxCharacters: 1_000, maxTraversalNodes: 100 });

        expect(preview.text.length).toBeLessThanOrEqual(1_000);
        expect(preview.truncated).toBe(true);
        expect(serializeDetailValue(value)).toContain("x".repeat(20_000));
    });

    it("stops reading a large array when the traversal budget is exhausted", () => {
        let elementReads = 0;
        const value = new Proxy(
            Array.from({ length: 10_000 }, (_, index) => index),
            {
                get(target, property, receiver) {
                    if (typeof property === "string" && /^\d+$/.test(property)) {
                        elementReads += 1;
                    }
                    return Reflect.get(target, property, receiver);
                },
            }
        );

        const preview = formatDetailPreview(value, { maxCharacters: 10_000, maxTraversalNodes: 8 });

        expect(elementReads).toBe(7);
        expect(preview.truncated).toBe(true);
    });

    it("stops traversing when the character budget is exhausted", () => {
        let trailingReads = 0;
        const value = {
            output: "x".repeat(20_000),
            get trailing() {
                trailingReads += 1;
                return "must not be read";
            },
        };

        const preview = formatDetailPreview(value, { maxCharacters: 100, maxTraversalNodes: 100 });

        expect(preview.text.length).toBeLessThanOrEqual(100);
        expect(preview.truncated).toBe(true);
        expect(trailingReads).toBe(0);
    });

    it("marks an incomplete structured value as truncated at the exact character limit", () => {
        const preview = formatDetailPreview({ ok: true }, { maxCharacters: 1, maxTraversalNodes: 10 });

        expect(preview.text.length).toBeLessThanOrEqual(1);
        expect(preview.truncated).toBe(true);
    });
});
