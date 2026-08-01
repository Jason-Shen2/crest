// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { getFileIcon } from "./file-icon";
import { DockerIcon, NpmIcon } from "./file-icons";

describe("getFileIcon", () => {
    it("resolves full-name package and Docker icons from basenames", () => {
        expect(getFileIcon("package.json", false, false)).toBe(NpmIcon);
        expect(getFileIcon("Dockerfile", false, false)).toBe(DockerIcon);
    });
});
