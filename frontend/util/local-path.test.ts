// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { getParentLocalPath, isAbsoluteLocalPath, joinLocalPath } from "./local-path";

describe("local path contracts", () => {
    it.each(["/repo/a.ts", "C:\\repo\\a.ts", "\\\\server\\share\\a.ts"])("accepts absolute local path %s", (path) =>
        expect(isAbsoluteLocalPath(path)).toBe(true)
    );

    it.each(["", "repo/a.ts", "C:repo\\a.ts", "\\\\server", "file:///repo/a.ts", "\0/repo"])(
        "rejects invalid local path %s",
        (path) => expect(isAbsoluteLocalPath(path)).toBe(false)
    );

    it("joins POSIX roots and UNC shares without changing root meaning", () => {
        expect(joinLocalPath("/", "name")).toBe("/name");
        expect(joinLocalPath("\\\\server\\share", "name")).toBe("//server/share/name");
    });

    it.each([
        ["/repo/docs/README.md", "/repo/docs"],
        ["/README.md", "/"],
        ["C:/README.md", "C:/"],
        ["C:\\repo\\README.md", "C:/repo"],
        ["//server/share/README.md", "//server/share"],
        ["README.md", "."],
    ])("gets parent local path for %s", (path, expected) => {
        expect(getParentLocalPath(path)).toBe(expected);
    });
});
