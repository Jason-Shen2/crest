// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { getWaveWindowType, isWorkspaceWindow, setWaveWindowType } from "./windowtype";

describe("workspace window type", () => {
    test("identifies workspace renderers", () => {
        setWaveWindowType("workspace");

        expect(getWaveWindowType()).toBe("workspace");
        expect(isWorkspaceWindow()).toBe(true);
    });
});
