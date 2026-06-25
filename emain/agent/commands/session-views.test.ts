// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildAgentForkPointViews, buildAgentTreeEntryViews, previewSessionEntry } from "./session-views";
import type { SessionTreeEntry } from "../harness/types";

function messageEntry(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: `2026-06-23T00:00:0${id}.000Z`,
        message: { role, content: [{ type: "text", text }] },
    } as unknown as SessionTreeEntry;
}

describe("session view helpers", () => {
    it("builds safe tree rows with current leaf marker", () => {
        const entries = [messageEntry("1", null, "user", "first question"), messageEntry("2", "1", "assistant", "answer")];
        const rows = buildAgentTreeEntryViews(entries, "2", new Map([["1", "Start"]]));
        expect(rows).toEqual([
            expect.objectContaining({ id: "1", label: "Start", preview: "first question", isCurrent: false }),
            expect.objectContaining({ id: "2", preview: "answer", isCurrent: true }),
        ]);
    });

    it("builds fork points only from user messages", () => {
        const entries = [messageEntry("1", null, "user", "fork here"), messageEntry("2", "1", "assistant", "no")];
        expect(buildAgentForkPointViews(entries)).toEqual([
            expect.objectContaining({ entryId: "1", preview: "fork here" }),
        ]);
    });

    it("truncates long previews", () => {
        const long = "x".repeat(140);
        expect(previewSessionEntry(messageEntry("1", null, "user", long))).toHaveLength(121);
    });

    it("ignores text content parts with non-string text", () => {
        const entry = messageEntry("1", null, "user", "safe");
        entry.message.content = [
            { type: "text", text: "safe" },
            { type: "text", text: { unsafe: true } },
            { type: "text", text: " text" },
        ] as any;

        expect(previewSessionEntry(entry)).toBe("safe text");
    });

    it("truncates previews without splitting unicode surrogate pairs", () => {
        const preview = previewSessionEntry(messageEntry("1", null, "user", `${"x".repeat(119)}😀more`));

        expect(Array.from(preview.slice(0, -1))).toHaveLength(120);
        expect(preview).toBe(`${"x".repeat(119)}😀…`);
    });
});
