// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
    buildAgentForkPointViews,
    buildAgentReferencePointViews,
    buildAgentTreeEntryViews,
    filterTreeForDisplay,
    isHiddenTreeEntry,
    previewSessionEntry,
} from "./session-views";
import type { SessionTreeEntry } from "../harness/types";
import { ContextCustomTypes } from "../context/journal";

function userMsg(id: string, parentId: string | null, text: string): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: `t-${id}`,
        message: { role: "user", content: [{ type: "text", text }] },
    } as unknown as SessionTreeEntry;
}

function asstMsg(id: string, parentId: string | null, text: string): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: `t-${id}`,
        message: { role: "assistant", content: text ? [{ type: "text", text }] : [] },
    } as unknown as SessionTreeEntry;
}

function toolMsg(id: string, parentId: string | null, text: string, role: "tool" | "toolResult" = "toolResult"): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: `t-${id}`,
        message: { role, content: [{ type: "text", text }] },
    } as unknown as SessionTreeEntry;
}

function leafEntry(id: string, parentId: string | null): SessionTreeEntry {
    return { type: "leaf", id, parentId, timestamp: `t-${id}` } as SessionTreeEntry;
}

function messageEntry(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: `2026-06-23T00:00:0${id}.000Z`,
        message: { role, content: [{ type: "text", text }] },
    } as unknown as SessionTreeEntry;
}

function contextEntry(id: string, parentId: string | null, customType: string): SessionTreeEntry {
    return {
        type: "custom",
        id,
        parentId,
        timestamp: `t-${id}`,
        customType,
    } as SessionTreeEntry;
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

    it("marks only active branch user rows as referenceable", () => {
        const root = userMsg("u1", null, "root");
        const activeAssistant = asstMsg("a1", "u1", "active answer");
        const activeUser = userMsg("u2", "a1", "active turn");
        const abandonedUser = userMsg("u-abandoned", "u1", "abandoned turn");
        const rows = buildAgentTreeEntryViews([root, activeAssistant, activeUser, abandonedUser], "u2");

        expect(rows.find((row) => row.id === "u1")).toMatchObject({ referenceable: true });
        expect(rows.find((row) => row.id === "u2")).toMatchObject({ referenceable: true });
        expect(rows.find((row) => row.id === "u-abandoned")).not.toHaveProperty("referenceable");
    });

    it("builds reference points from active user turn roots only", () => {
        const root = userMsg("u1", null, "root");
        const assistant = asstMsg("a1", "u1", "answer");
        const nextUser = userMsg("u2", "a1", "next");

        expect(buildAgentReferencePointViews([root, assistant, nextUser])).toEqual([
            expect.objectContaining({ entryId: "u1", preview: "root" }),
            expect.objectContaining({ entryId: "u2", preview: "next" }),
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

    describe("isHiddenTreeEntry", () => {
        it("hides leaf entries", () => {
            expect(isHiddenTreeEntry(leafEntry("l1", null))).toBe(true);
        });
        it("keeps tool and toolResult messages (FilterMode decides at display time)", () => {
            expect(isHiddenTreeEntry(toolMsg("t1", null, "ls output", "tool"))).toBe(false);
            expect(isHiddenTreeEntry(toolMsg("t2", null, "ls output", "toolResult"))).toBe(false);
        });
        it("keeps assistant messages with no text content (tool-only turns reach the renderer)", () => {
            expect(isHiddenTreeEntry(asstMsg("a1", null, ""))).toBe(false);
        });
        it("keeps user messages and non-empty assistant messages", () => {
            expect(isHiddenTreeEntry(userMsg("u1", null, "hi"))).toBe(false);
            expect(isHiddenTreeEntry(asstMsg("a2", null, "hello"))).toBe(false);
        });
        it("hides every recognized context control entry", () => {
            for (const customType of Object.values(ContextCustomTypes)) {
                expect(isHiddenTreeEntry(contextEntry(customType, null, customType))).toBe(true);
            }
        });
    });

    describe("filterTreeForDisplay", () => {
        it("keeps tool/toolResult/empty-assistant nodes (only leaf/label are stripped)", () => {
            // Sequence: user -> empty assistant (tool call) -> toolResult -> final assistant
            const u1 = userMsg("u1", null, "nice");
            const aEmpty = asstMsg("a-toolcall", "u1", "");
            const tr = toolMsg("tr1", "a-toolcall", "[.aandroid/ ...]");
            const aFinal = asstMsg("a-final", "tr1", "I see a file named two_sum.py");
            const leaf = leafEntry("leaf", "a-final");

            const { entries, effectiveLeafId } = filterTreeForDisplay([u1, aEmpty, tr, aFinal, leaf], "leaf");

            // Only the leaf pointer is removed; everything else survives untouched.
            expect(entries.map((e) => e.id)).toEqual(["u1", "a-toolcall", "tr1", "a-final"]);
            expect(entries[3]!.parentId).toBe("tr1");
            expect(effectiveLeafId).toBe("a-final");
        });

        it("passes through when nothing is hidden", () => {
            const u1 = userMsg("u1", null, "hi");
            const a1 = asstMsg("a1", "u1", "hello");
            const { entries, effectiveLeafId } = filterTreeForDisplay([u1, a1], "a1");
            expect(entries.map((e) => e.id)).toEqual(["u1", "a1"]);
            expect(entries[1]!.parentId).toBe("u1");
            expect(effectiveLeafId).toBe("a1");
        });

        it("reparents a transactional user past every hidden context ancestor", () => {
            const previous = userMsg("previous", null, "before");
            const artifact = contextEntry("artifact", "previous", ContextCustomTypes.artifact);
            const attach = contextEntry("attach", "artifact", ContextCustomTypes.attach);
            const manifest = contextEntry("manifest", "attach", ContextCustomTypes.transactionManifest);
            const transactionalUser = userMsg("user", "manifest", "visible turn");

            const { entries, effectiveLeafId } = filterTreeForDisplay(
                [previous, artifact, attach, manifest, transactionalUser],
                "user"
            );

            expect(entries.map((entry) => entry.id)).toEqual(["previous", "user"]);
            expect(entries[1]!.parentId).toBe("previous");
            expect(effectiveLeafId).toBe("user");
        });
    });
});
