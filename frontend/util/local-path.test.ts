// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isAbsoluteLocalPath, joinLocalPath } from "./local-path";

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
});
