// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { JsonlSessionMetadata, SessionTreeEntry } from "../harness/types";
import { captureContextArtifactDraft, getModelVisibleMessageEntryIds } from "./snapshot";
import { ContextReferenceError } from "./types";

const Metadata: JsonlSessionMetadata = {
    id: "source-session",
    path: "/tmp/source.jsonl",
    cwd: "/tmp/source",
    createdAt: "2026-07-22T00:00:00.000Z",
};

function entry(id: string, parentId: string | null, message: unknown): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp: `2026-07-22T00:00:${id.length.toString().padStart(2, "0")}.000Z`,
        message,
    } as SessionTreeEntry;
}

function customEntry(id: string, parentId: string | null): SessionTreeEntry {
    return { type: "custom", id, parentId, timestamp: "2026-07-22T00:00:00.000Z", customType: "control" };
}

function captureTurn(entries: SessionTreeEntry[], sourceTurnId = "user-1") {
    return captureContextArtifactDraft({
        sourceMetadata: Metadata,
        sourceEntries: entries,
        sourceLeafId: entries.at(-1)?.id ?? null,
        sourceTitle: "Source title",
        sourceKind: "turn",
        sourceTurnId,
        now: () => new Date("2026-07-22T12:00:00.000Z"),
    });
}

function captureToolArguments(argumentsValue: unknown) {
    return captureTurn([
        entry("user-1", null, { role: "user", content: [{ type: "text", text: "question" }] }),
        entry("assistant-1", "user-1", {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "read", arguments: argumentsValue }],
        }),
    ]);
}

describe("context snapshot capture", () => {
    it("captures one atomic turn as normalized structured content", () => {
        const user = entry("user-1", null, {
            role: "user",
            content: [
                { type: "text", text: "Please inspect this" },
                { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
            ],
        });
        const assistant = entry("assistant-1", "user-1", {
            role: "assistant",
            content: [
                { type: "thinking", thinking: "private", thinkingSignature: "opaque-thought" },
                { type: "text", text: "I will inspect it", textSignature: "opaque-text" },
                {
                    type: "toolCall",
                    id: "call-1",
                    name: "read",
                    arguments: { path: "/tmp/file", offset: 2 },
                    thoughtSignature: "opaque-call",
                },
            ],
            responseId: "provider-id",
            usage: { input: 1 },
            diagnostics: [{ message: "diagnostic" }],
        });
        const result = entry("result-1", "assistant-1", {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            isError: true,
            content: [
                { type: "text", text: "file contents" },
                { type: "image", data: "d29ybGQ=", mimeType: "image/jpeg" },
            ],
            details: { secret: "not captured" },
        });
        const laterUser = entry("user-2", "result-1", {
            role: "user",
            content: [{ type: "text", text: "later turn" }],
        });

        const draft = captureTurn([user, assistant, result, laterUser]);

        expect(draft).not.toHaveProperty("draftId");
        expect(draft).not.toHaveProperty("targetSessionPath");
        expect(draft).not.toHaveProperty("expiresAt");
        expect(draft.artifact.messages).toEqual([
            {
                role: "user",
                content: [
                    { type: "text", text: "Please inspect this" },
                    { type: "image_omitted", mimeType: "image/png", byteLength: 5 },
                ],
            },
            {
                role: "assistant",
                content: [
                    { type: "text", text: "I will inspect it" },
                    { type: "tool_call", id: "call-1", name: "read", arguments: { path: "/tmp/file", offset: 2 } },
                ],
            },
            {
                role: "tool_result",
                toolCallId: "call-1",
                toolName: "read",
                isError: true,
                content: [
                    { type: "text", text: "file contents" },
                    { type: "image_omitted", mimeType: "image/jpeg", byteLength: 5 },
                ],
            },
        ]);
        expect(draft.artifact.provenance).toMatchObject({
            sourceKind: "turn",
            sourceSessionId: "source-session",
            sourceSessionPath: "/tmp/source.jsonl",
            sourceSessionTitle: "Source title",
            sourceCwd: "/tmp/source",
            sourceTurnId: "user-1",
            sourceLeafId: "user-2",
            sourceMessageEntryIds: ["user-1", "assistant-1", "result-1"],
            preview: "Please inspect this",
            capturedAt: "2026-07-22T12:00:00.000Z",
        });
    });

    it("captures only the supplied active session branch and its leaf", () => {
        const user = entry("user-1", null, { role: "user", content: [{ type: "text", text: "active" }] });
        const assistant = entry("assistant-1", "user-1", {
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
        });
        const draft = captureContextArtifactDraft({
            sourceMetadata: Metadata,
            sourceEntries: [user, assistant],
            sourceLeafId: "assistant-1",
            sourceKind: "session",
            now: () => new Date("2026-07-22T12:00:00.000Z"),
        });

        expect(draft.artifact.provenance).toMatchObject({
            sourceKind: "session",
            sourceLeafId: "assistant-1",
            sourceMessageEntryIds: ["user-1", "assistant-1"],
        });
        expect(draft.artifact.provenance.sourceTurnId).toBeUndefined();
        expect(draft.artifact.messages).toHaveLength(2);
    });

    it("rejects sources that are not active user turn roots", () => {
        const user = entry("user-1", null, { role: "user", content: [{ type: "text", text: "question" }] });
        const assistant = entry("assistant-1", "user-1", {
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
        });
        const toolResult = entry("result-1", "assistant-1", {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            isError: false,
            content: [{ type: "text", text: "result" }],
        });
        const custom = customEntry("custom-1", "result-1");

        expect(() => captureTurn([user, assistant, toolResult, custom], "assistant-1")).toThrow(ContextReferenceError);
        expect(() => captureTurn([user, assistant, toolResult, custom], "result-1")).toThrow(ContextReferenceError);
        expect(() => captureTurn([user, assistant, toolResult, custom], "custom-1")).toThrow(ContextReferenceError);
    });

    it("rejects snapshots without useful text or tool content", () => {
        const user = entry("user-1", null, {
            role: "user",
            content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        });

        expect(() => captureTurn([user])).toThrow(ContextReferenceError);
    });

    it("bounds canonical normalized JSON while excluding omitted image bytes", () => {
        const oversized = entry("user-1", null, {
            role: "user",
            content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }],
        });
        const imageOnly = entry("user-1", null, {
            role: "user",
            content: [
                { type: "text", text: "small text" },
                { type: "image", data: "a".repeat(3 * 1024 * 1024), mimeType: "image/png" },
            ],
        });

        expect(() => captureTurn([oversized])).toThrow(expect.objectContaining({ code: "source_too_large" }));
        expect(captureTurn([imageOnly]).artifact.canonicalByteLength).toBeLessThan(2 * 1024 * 1024);
    });

    it("hashes canonical normalized messages deterministically", () => {
        const makeEntries = (text: string, argumentsValue: Record<string, unknown>) => [
            entry("user-1", null, { role: "user", content: [{ type: "text", text }] }),
            entry("assistant-1", "user-1", {
                role: "assistant",
                content: [{ type: "toolCall", id: "call-1", name: "read", arguments: argumentsValue }],
            }),
        ];

        const first = captureTurn(makeEntries("same", { a: 1, b: 2 }));
        const same = captureTurn(makeEntries("same", { b: 2, a: 1 }));
        const changedText = captureTurn(makeEntries("changed", { a: 1, b: 2 }));
        const changedTool = captureTurn(makeEntries("same", { a: 2, b: 2 }));

        expect(first.artifact.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(first.artifact.snapshotSha256).toBe(same.artifact.snapshotSha256);
        expect(first.artifact.canonicalByteLength).toBe(same.artifact.canonicalByteLength);
        expect(first.artifact.snapshotSha256).not.toBe(changedText.artifact.snapshotSha256);
        expect(first.artifact.snapshotSha256).not.toBe(changedTool.artifact.snapshotSha256);
    });

    it("preserves prototype-like tool argument keys in canonical snapshots", () => {
        const firstArguments = JSON.parse('{"__proto__":{"value":"one"},"constructor":"first","prototype":"first"}');
        const secondArguments = JSON.parse(
            '{"__proto__":{"value":"a longer value"},"constructor":"first","prototype":"first"}'
        );
        const first = captureTurn([
            entry("user-1", null, { role: "user", content: [{ type: "text", text: "same" }] }),
            entry("assistant-1", "user-1", {
                role: "assistant",
                content: [{ type: "toolCall", id: "call-1", name: "read", arguments: firstArguments }],
            }),
        ]);
        const second = captureTurn([
            entry("user-1", null, { role: "user", content: [{ type: "text", text: "same" }] }),
            entry("assistant-1", "user-1", {
                role: "assistant",
                content: [{ type: "toolCall", id: "call-1", name: "read", arguments: secondArguments }],
            }),
        ]);
        const firstToolCall = first.artifact.messages[1]!.content[0] as { arguments: Record<string, unknown> };

        expect(Object.hasOwn(firstToolCall.arguments, "__proto__")).toBe(true);
        expect(firstToolCall.arguments).toMatchObject({ constructor: "first", prototype: "first" });
        expect(first.artifact.snapshotSha256).not.toBe(second.artifact.snapshotSha256);
        expect(first.artifact.canonicalByteLength).not.toBe(second.artifact.canonicalByteLength);
    });

    it("rejects whitespace-only user text", () => {
        const user = entry("user-1", null, { role: "user", content: [{ type: "text", text: " \n\t " }] });

        expect(() => captureTurn([user])).toThrow(expect.objectContaining({ code: "invalid_input" }));
    });

    it("rejects empty tool results", () => {
        const user = entry("user-1", null, { role: "user", content: [] });
        const toolResult = entry("result-1", "user-1", {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            isError: false,
            content: [],
        });

        expect(() => captureTurn([user, toolResult])).toThrow(expect.objectContaining({ code: "invalid_input" }));
    });

    it("rejects image-only tool results", () => {
        const user = entry("user-1", null, { role: "user", content: [] });
        const toolResult = entry("result-1", "user-1", {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            isError: false,
            content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
        });

        expect(() => captureTurn([user, toolResult])).toThrow(expect.objectContaining({ code: "invalid_input" }));
    });

    it("uses the first non-blank text for previews", () => {
        const user = entry("user-1", null, { role: "user", content: [{ type: "text", text: "  \n" }] });
        const assistant = entry("assistant-1", "user-1", {
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
        });

        expect(captureTurn([user, assistant]).artifact.provenance.preview).toBe("answer");
    });

    it.each([
        ["Date", new Date("2026-07-22T00:00:00.000Z")],
        ["undefined root", undefined],
        ["undefined nested object", { value: undefined }],
        ["undefined nested array", ["valid", undefined]],
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
        ["negative infinity", Number.NEGATIVE_INFINITY],
        ["BigInt", BigInt(1)],
        ["function", () => "invalid"],
        ["symbol", Symbol("invalid")],
    ])("rejects unsupported tool arguments: %s", (_name, argumentsValue) => {
        const user = entry("user-1", null, { role: "user", content: [{ type: "text", text: "question" }] });
        const assistant = entry("assistant-1", "user-1", {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "read", arguments: argumentsValue }],
        });

        expect(() => captureTurn([user, assistant])).toThrow(expect.objectContaining({ code: "invalid_input" }));
    });

    it("rejects cyclic tool arguments with an invalid input error", () => {
        const argumentsValue: { self?: unknown } = {};
        argumentsValue.self = argumentsValue;
        const user = entry("user-1", null, { role: "user", content: [{ type: "text", text: "question" }] });
        const assistant = entry("assistant-1", "user-1", {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "read", arguments: argumentsValue }],
        });

        expect(() => captureTurn([user, assistant])).toThrow(expect.objectContaining({ code: "invalid_input" }));
    });

    it("deep-copies supported nested tool arguments before hashing", () => {
        const argumentsValue = JSON.parse(
            '{"__proto__":{"nested":[1,{"value":"stable"}]},"constructor":{"items":[true,null]},"prototype":"kept","regular":[{"deep":"copy"}]}'
        );
        const expectedArguments = JSON.parse(
            '{"__proto__":{"nested":[1,{"value":"stable"}]},"constructor":{"items":[true,null]},"prototype":"kept","regular":[{"deep":"copy"}]}'
        );
        const user = entry("user-1", null, { role: "user", content: [{ type: "text", text: "question" }] });
        const assistant = entry("assistant-1", "user-1", {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "read", arguments: argumentsValue }],
        });
        const draft = captureTurn([user, assistant]);
        const capturedArguments = (draft.artifact.messages[1]!.content[0] as { arguments: Record<string, unknown> })
            .arguments;
        const hash = draft.artifact.snapshotSha256;

        expect(capturedArguments).toEqual(argumentsValue);
        expect(Object.hasOwn(capturedArguments, "__proto__")).toBe(true);
        argumentsValue.__proto__.nested[1].value = "changed";
        argumentsValue.constructor.items[0] = false;
        argumentsValue.regular[0].deep = "changed";

        expect(capturedArguments).toEqual(expectedArguments);
        expect(draft.artifact.snapshotSha256).toBe(hash);
    });

    it("accepts unpadded base64 image data with valid two- and three-character remainders", () => {
        const user = entry("user-1", null, {
            role: "user",
            content: [
                { type: "text", text: "image" },
                { type: "image", data: "TQ", mimeType: "image/png" },
                { type: "image", data: "aGVsbG8", mimeType: "image/png" },
            ],
        });

        expect(captureTurn([user]).artifact.messages[0]!.content).toEqual([
            { type: "text", text: "image" },
            { type: "image_omitted", mimeType: "image/png", byteLength: 1 },
            { type: "image_omitted", mimeType: "image/png", byteLength: 5 },
        ]);
    });

    it.each(["====", "A", "A=AA", "A===", "A@AA"])("rejects malformed base64 image data: %s", (data) => {
        const user = entry("user-1", null, {
            role: "user",
            content: [
                { type: "text", text: "image" },
                { type: "image", data, mimeType: "image/png" },
            ],
        });

        expect(() => captureTurn([user])).toThrow(expect.objectContaining({ code: "invalid_input" }));
    });

    it("rejects arrays with enumerable symbol keys", () => {
        const argumentsValue = ["valid"];
        Object.defineProperty(argumentsValue, Symbol("extra"), { value: "invalid", enumerable: true });

        expect(() => captureToolArguments(argumentsValue)).toThrow(expect.objectContaining({ code: "invalid_input" }));
    });

    it("rejects array index accessors without executing them", () => {
        let getterCalls = 0;
        const argumentsValue: unknown[] = [];
        Object.defineProperty(argumentsValue, "0", {
            enumerable: true,
            get() {
                getterCalls++;
                return "invalid";
            },
        });

        expect(() => captureToolArguments(argumentsValue)).toThrow(expect.objectContaining({ code: "invalid_input" }));
        expect(getterCalls).toBe(0);
    });

    it.each([true, false])("rejects enumerable=%s own array map methods without calling them", (enumerable) => {
        let mapCalls = 0;
        const argumentsValue = ["valid"];
        Object.defineProperty(argumentsValue, "map", {
            enumerable,
            value: () => {
                mapCalls++;
                return ["invalid"];
            },
        });

        expect(() => captureToolArguments(argumentsValue)).toThrow(expect.objectContaining({ code: "invalid_input" }));
        expect(mapCalls).toBe(0);
    });

    it.each([
        ["sparse", ["first", , "third"]],
        ["extra string property", Object.assign(["valid"], { extra: "invalid" })],
    ])("rejects %s arrays", (_name, argumentsValue) => {
        expect(() => captureToolArguments(argumentsValue)).toThrow(expect.objectContaining({ code: "invalid_input" }));
    });

    it("deep-copies dense nested arrays through descriptors", () => {
        const argumentsValue: [{ value: string }[], number[]] = [[{ value: "stable" }], [1, 2, 3]];
        const draft = captureToolArguments(argumentsValue);
        const capturedArguments = (draft.artifact.messages[1]!.content[0] as { arguments: unknown }).arguments;

        argumentsValue[0]![0]!.value = "changed";
        argumentsValue[1]![0] = 0;

        expect(capturedArguments).toEqual([[{ value: "stable" }], [1, 2, 3]]);
    });
});

describe("model-visible session message IDs", () => {
    it("returns message IDs from the active path without compaction", () => {
        const user = entry("user-1", null, { role: "user", content: [{ type: "text", text: "question" }] });
        const custom = customEntry("custom-1", "user-1");
        const assistant = entry("assistant-1", "custom-1", {
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
        });

        expect(getModelVisibleMessageEntryIds([user, custom, assistant])).toEqual(["user-1", "assistant-1"]);
    });

    it("uses the latest compaction first-kept boundary", () => {
        const oldUser = entry("user-1", null, { role: "user", content: [{ type: "text", text: "old" }] });
        const keptAssistant = entry("assistant-1", "user-1", {
            role: "assistant",
            content: [{ type: "text", text: "kept" }],
        });
        const firstCompaction = {
            type: "compaction",
            id: "compact-1",
            parentId: "assistant-1",
            timestamp: "2026-07-22T00:00:00.000Z",
            summary: "old summary",
            firstKeptEntryId: "assistant-1",
            tokensBefore: 10,
        } as SessionTreeEntry;
        const newUser = entry("user-2", "compact-1", { role: "user", content: [{ type: "text", text: "new" }] });
        const latestCompaction = {
            ...firstCompaction,
            id: "compact-2",
            parentId: "user-2",
            firstKeptEntryId: "user-2",
        } as SessionTreeEntry;
        const finalAssistant = entry("assistant-2", "compact-2", {
            role: "assistant",
            content: [{ type: "text", text: "final" }],
        });

        expect(
            getModelVisibleMessageEntryIds([
                oldUser,
                keptAssistant,
                firstCompaction,
                newUser,
                latestCompaction,
                finalAssistant,
            ])
        ).toEqual(["user-2", "assistant-2"]);
    });
});
