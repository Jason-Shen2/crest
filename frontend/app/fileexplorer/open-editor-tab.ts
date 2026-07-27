// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceTopTabController } from "@/app/workspace/top-tab-controller";

export type OpenFileInEditorTabResult = {
    tabId: string;
    created: boolean;
};

export async function openFileInEditorTab(
    path: string,
    controller: Pick<WorkspaceTopTabController, "openFile">
): Promise<OpenFileInEditorTabResult> {
    const tabId = controller.openFile(path);
    return { tabId, created: true };
}
