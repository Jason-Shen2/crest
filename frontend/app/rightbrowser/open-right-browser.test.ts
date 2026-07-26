// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { openUrlInRightBrowser } from "./open-right-browser";

describe("openUrlInRightBrowser", () => {
    it("opens a validated HTTP URL in the right-side Browser", () => {
        const layoutModel = { openRightTool: vi.fn() };
        const rightBrowserModel = { newTab: vi.fn() };

        openUrlInRightBrowser("https://example.com", layoutModel, rightBrowserModel);

        expect(layoutModel.openRightTool).toHaveBeenCalledWith("browser");
        expect(rightBrowserModel.newTab).toHaveBeenCalledWith("https://example.com", true);
    });

    it.each(["", "file:///tmp/a", "javascript:alert(1)", "not a url"])("rejects %j", (url) => {
        expect(() =>
            openUrlInRightBrowser(url, { openRightTool: vi.fn() }, { newTab: vi.fn() })
        ).toThrow("http");
    });
});
