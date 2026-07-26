// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import type { RightBrowserModel } from "./right-browser";

export function openUrlInRightBrowser(
    url: string,
    layoutModel: Pick<WorkspaceLayoutModel, "openRightTool">,
    rightBrowserModel: Pick<RightBrowserModel, "newTab">
): void {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error("Right Browser requires an http(s) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Right Browser requires an http(s) URL");
    }
    layoutModel.openRightTool("browser");
    rightBrowserModel.newTab(url, true);
}
