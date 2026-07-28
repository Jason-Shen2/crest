// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { makeProcessOwnerIdentity, readProcessStartToken } from "./process-owner";

describe("process owner identity", () => {
    test("uses the current pid, platform start token, and a fresh nonce", async () => {
        const first = await makeProcessOwnerIdentity();
        const second = await makeProcessOwnerIdentity();

        expect(first.pid).toBe(process.pid);
        expect(first.processStartToken).toBe(await readProcessStartToken(process.pid));
        expect(first.processStartToken.length).toBeGreaterThan(0);
        expect(first.nonce).toMatch(/^[0-9a-f]{64}$/);
        expect(second.nonce).not.toBe(first.nonce);
    });

    test("rejects a process that no longer exists", async () => {
        await expect(readProcessStartToken(2 ** 30)).rejects.toThrow();
    });
});
