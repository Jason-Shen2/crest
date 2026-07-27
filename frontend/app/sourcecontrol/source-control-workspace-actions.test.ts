// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

describe("SourceControlWorkspaceActions", () => {
    it("keeps the renderer-local boundary serializable", () => {
        const input = { repoRoot: "/repo", path: "a.ts", mode: "-" as const };
        expect(JSON.parse(JSON.stringify(input))).toEqual(input);
    });
});
