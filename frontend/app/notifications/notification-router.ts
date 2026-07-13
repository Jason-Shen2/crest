// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import type { AppNotification } from "./notifications-model";

export type NotificationDelivery = "silent" | "toast" | "system";

export type NotificationRouteOptions = {
    focused: boolean;
    visible: boolean;
    allowToast?: boolean;
    pushToast: (note: AppNotification) => void;
    notifySystem?: (note: AppNotification) => void;
};

function getSystemNotificationTitle(note: AppNotification): string {
    return note.title || note.agentName || "Crest";
}

function getSystemNotificationBody(note: AppNotification): string {
    return note.body || note.title || note.agentName || "Notification";
}

export async function notifyAppNotificationSystem(note: AppNotification): Promise<void> {
    await RpcApi.NotifyCommand(
        TabRpcClient,
        {
            title: getSystemNotificationTitle(note),
            body: getSystemNotificationBody(note),
            silent: false,
        },
        { timeout: 2000 }
    );
}

export function shouldSuppressVisibleNotification({
    focused,
    visible,
}: {
    focused: boolean;
    visible: boolean;
}): boolean {
    return focused && visible;
}

export function routeAppNotification(note: AppNotification, options: NotificationRouteOptions): NotificationDelivery {
    if (shouldSuppressVisibleNotification(options)) {
        return "silent";
    }
    if (!options.focused) {
        if (options.notifySystem) {
            options.notifySystem(note);
        } else {
            fireAndForget(() => notifyAppNotificationSystem(note));
        }
        return "system";
    }
    if (options.allowToast ?? true) {
        options.pushToast(note);
        return "toast";
    }
    return "silent";
}
