// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { formatDetailPreview, serializeDetailValue } from "./detail-value";

function hasUnpairedSurrogate(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next < 0xdc00 || next > 0xdfff) {
                return true;
            }
            index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return true;
        }
    }
    return false;
}

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
        let ownKeysCalls = 0;
        const value = new Proxy(
            Array.from({ length: 10_000 }, (_, index) => index),
            {
                get(target, property, receiver) {
                    if (typeof property === "string" && /^\d+$/.test(property)) {
                        elementReads += 1;
                    }
                    return Reflect.get(target, property, receiver);
                },
                ownKeys(target) {
                    ownKeysCalls += 1;
                    return Reflect.ownKeys(target);
                },
            }
        );

        const preview = formatDetailPreview(value, { maxCharacters: 10_000, maxTraversalNodes: 8 });

        expect(ownKeysCalls).toBe(0);
        expect(elementReads).toBe(7);
        expect(preview.truncated).toBe(true);
    });

    it("preserves sparse array positions as null", () => {
        const value = ["first", , "third"];

        const preview = formatDetailPreview(value, { maxCharacters: 1_000, maxTraversalNodes: 10 });

        expect(preview).toEqual({
            text: '[\n  "first",\n  null,\n  "third"\n]',
            truncated: false,
        });
    });

    it("does not split a Unicode surrogate pair when truncating", () => {
        const preview = formatDetailPreview("😀x", { maxCharacters: 2, maxTraversalNodes: 10 });

        expect(preview.text.length).toBeLessThanOrEqual(2);
        expect(preview.truncated).toBe(true);
        expect(hasUnpairedSurrogate(preview.text)).toBe(false);
    });

    it("represents circular object and array references without recursing forever", () => {
        const object: Record<string, unknown> = {};
        object.self = object;
        const array: unknown[] = [];
        array.push(array);

        expect(formatDetailPreview(object, { maxCharacters: 1_000, maxTraversalNodes: 10 })).toEqual({
            text: '{\n  "self": "[Circular]"\n}',
            truncated: false,
        });
        expect(formatDetailPreview(array, { maxCharacters: 1_000, maxTraversalNodes: 10 })).toEqual({
            text: '[\n  "[Circular]"\n]',
            truncated: false,
        });
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
