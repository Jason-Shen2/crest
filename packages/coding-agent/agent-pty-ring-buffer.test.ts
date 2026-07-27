// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { AgentPtyRingBuffer } from "./agent-pty-ring-buffer";

describe("AgentPtyRingBuffer", () => {
    it("caps retained output by bytes and complete lines", () => {
        const buffer = new AgentPtyRingBuffer({ maxBytes: 12, maxLines: 3 });

        buffer.append("one\n");
        buffer.append("two\n");
        buffer.append("three\n");
        buffer.append("four\n");

        expect(buffer.text()).toBe("three\nfour\n");
        expect(buffer.lineCount()).toBe(2);
        expect(buffer.byteLength()).toBeLessThanOrEqual(12);
    });

    it("keeps the newest suffix when one chunk is larger than the byte cap", () => {
        const buffer = new AgentPtyRingBuffer({ maxBytes: 5, maxLines: 10 });

        buffer.append("abcdefghi");

        expect(buffer.text()).toBe("efghi");
        expect(buffer.byteLength()).toBe(5);
    });

    it("counts blank lines toward the line cap", () => {
        const buffer = new AgentPtyRingBuffer({ maxBytes: 1024, maxLines: 3 });

        buffer.append("\n".repeat(100));

        expect(buffer.lineCount()).toBe(3);
        expect(buffer.text()).toBe("\n\n\n");
    });
});
