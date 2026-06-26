// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { commandNoop, commandSuccess } from "./session-command-results";

describe("session command results", () => {
    it("formats success messages", () => {
        expect(commandSuccess("Copied 120 characters.")).toEqual({
            status: "success",
            message: "Copied 120 characters.",
        });
    });

    it("formats noop messages", () => {
        expect(commandNoop("No assistant response to copy yet.")).toEqual({
            status: "noop",
            message: "No assistant response to copy yet.",
        });
    });
});
