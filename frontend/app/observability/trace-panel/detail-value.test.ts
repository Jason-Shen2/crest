// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { formatDetailPreview, serializeDetailValue } from "./detail-value";

describe("detail value formatting", () => {
    it("keeps string values unchanged", () => {
        expect(serializeDetailValue("plain text")).toBe("plain text");
    });

    it("pretty prints structured values", () => {
        expect(serializeDetailValue({ ok: true })).toBe('{\n  "ok": true\n}');
    });

    it("bounds preview serialization without changing the copied value", () => {
        const value = { output: "x".repeat(20_000) };
        const preview = formatDetailPreview(value, { maxCharacters: 1_000 });

        expect(preview.text.length).toBeLessThanOrEqual(1_001);
        expect(preview.truncated).toBe(true);
        expect(serializeDetailValue(value)).toContain("x".repeat(20_000));
    });
});
