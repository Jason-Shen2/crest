// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { blockViewToIcon, blockViewToName } from "./blockutil";

describe("block view labels", () => {
    it("keeps agent named like a terminal while distinguishing it by icon", () => {
        expect(blockViewToName("agent")).toBe("Terminal");
        expect(blockViewToIcon("agent")).toBe("sparkles");
    });
});
