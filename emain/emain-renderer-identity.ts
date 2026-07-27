// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

type ValidateTerminalTab = (workspaceId: string, tabId: string) => Promise<boolean>;

export async function resolveWaveRendererKind(
    workspaceId: string,
    tabId: string,
    validateTerminalTab: ValidateTerminalTab
): Promise<WaveInitOpts["rendererKind"]> {
    if (!(await validateTerminalTab(workspaceId, tabId))) {
        throw new Error(`${tabId} is not a Terminal Tab`);
    }
    return "terminal";
}
