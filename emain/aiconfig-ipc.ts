// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// aiconfig-ipc.ts — IPC handlers for the AI config + provider listing
// surface that used to live in Go (pkg/aiusechat/listmodels.go and the
// ListProviderModelsCommand wshrpc). The renderer's model picker now
// invokes these directly via `window.api.ai.*`.
//
// IPC contract (mirrored in preload.ts + ElectronApi.ai typings):
//
//   handle "ai:list-provider-models" (input)
//     input = { apitype, baseurl?, apitoken?, tokensecretname? }
//     - if apitoken is empty and tokensecretname is set, the handler
//       resolves it via the safeStorage-backed secrets file.
//     - returns ProviderModelInfo[]
//
// The aiconfig dir is separate from emain/ai/ because emain/ai/ holds
// the pi-ai library source we vendored — keeping crest-specific config
// glue in its own dir avoids confusion with the library.

import * as electron from "electron";

import {
    listProviderModels,
    listRegistryModels,
    type ListProviderModelsInput,
    type ProviderModelInfo,
    type RegistryModelInfo,
} from "./aiconfig/list-provider-models";
import { getSecret } from "./aiconfig/secrets";
import {
    readAIUserConfig,
    writeAIUserConfig,
    type AIUserConfigReadResult,
} from "./aiconfig/user-config";

interface ListProviderModelsIpcInput extends ListProviderModelsInput {
    tokensecretname?: string;
}

/**
 * Wire the AI config / listing IPC handlers. Call once at app startup
 * from emain-ipc.ts initIpcHandlers().
 */
export function registerAiConfigIpcHandlers(): void {
    electron.ipcMain.handle(
        "ai:list-provider-models",
        async (_event, input: ListProviderModelsIpcInput): Promise<ProviderModelInfo[]> => {
            let token = (input.apitoken ?? "").trim();
            if (!token && input.tokensecretname) {
                const value = await getSecret(input.tokensecretname);
                if (value == null) {
                    throw new Error(
                        `secret "${input.tokensecretname}" not found — open Settings → AI Provider to set the key`,
                    );
                }
                token = value;
            }
            return listProviderModels({
                apitype: input.apitype,
                baseurl: input.baseurl,
                apitoken: token,
            });
        },
    );

    electron.ipcMain.handle(
        "ai:list-registry-models",
        async (_event, provider: string): Promise<RegistryModelInfo[]> => {
            return listRegistryModels(provider);
        },
    );

    electron.ipcMain.handle(
        "ai:get-user-config",
        async (): Promise<AIUserConfigReadResult> => {
            return readAIUserConfig();
        },
    );

    electron.ipcMain.handle(
        "ai:write-user-config",
        async (_event, cfg: Parameters<typeof writeAIUserConfig>[0]): Promise<void> => {
            await writeAIUserConfig(cfg);
        },
    );
}
