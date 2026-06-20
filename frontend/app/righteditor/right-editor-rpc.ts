// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { base64ToString, stringToBase64 } from "@/util/util";

export const RightEditorProductionRpc = {
    readFile: async (path: string) => {
        const fileData = await RpcApi.FileReadCommand(TabRpcClient, {
            info: { path },
        });
        return {
            text: fileData?.data64 ? base64ToString(fileData.data64) : "",
            readonly: fileData?.info?.readonly ?? false,
        };
    },
    writeFile: async (path: string, text: string) => {
        await RpcApi.FileWriteCommand(TabRpcClient, {
            info: { path },
            data64: stringToBase64(text),
        });
    },
};
