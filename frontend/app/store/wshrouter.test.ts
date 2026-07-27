// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { makeTabRouteId, makeWorkspaceRouteId } from "./wshrouter";

describe("workspace routes", () => {
    test("uses the workspace route namespace", () => {
        expect(makeWorkspaceRouteId("ws-1")).toBe("workspace:ws-1");
    });

    test("does not collide with a tab route", () => {
        expect(makeWorkspaceRouteId("shared-id")).not.toBe(makeTabRouteId("shared-id"));
    });
});
