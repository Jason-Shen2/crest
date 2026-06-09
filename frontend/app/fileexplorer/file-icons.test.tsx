// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JsonIcon } from "./file-icons";

describe("file explorer icons", () => {
    it("renders json files with a document braces icon", () => {
        const markup = renderToStaticMarkup(<JsonIcon size={16} />);

        expect(markup).toContain("#f59e0b");
        expect(markup).toContain("M9 10.5");
        expect(markup).toContain("M15 10.5");
    });
});
