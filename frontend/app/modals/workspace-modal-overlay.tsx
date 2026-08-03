// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { useEffect, useRef } from "react";

const VisibleTokens = new Set<symbol>();
let reportedVisible: boolean;
let hideTimer: ReturnType<typeof setTimeout>;

function reportVisible(visible: boolean) {
    reportedVisible = visible;
    if (atoms?.modalOpen) {
        globalStore.set(atoms.modalOpen, visible);
    }
    getApi()?.setWorkspaceOverlayVisible?.(visible);
}

function setTokenVisible(token: symbol, visible: boolean) {
    if (visible) {
        VisibleTokens.add(token);
    } else {
        VisibleTokens.delete(token);
    }
    if (VisibleTokens.size > 0) {
        if (hideTimer != null) {
            clearTimeout(hideTimer);
            hideTimer = null;
        }
        if (!reportedVisible) {
            reportVisible(true);
        }
        return;
    }
    if (reportedVisible) {
        hideTimer ??= setTimeout(() => {
            hideTimer = null;
            if (VisibleTokens.size === 0) {
                reportVisible(false);
            }
        }, 0);
        return;
    }
    reportVisible(false);
}

export function WorkspaceModalOverlay({ visible }: { visible: boolean }) {
    const tokenRef = useRef(Symbol("workspace-modal-overlay"));

    useEffect(() => {
        setTokenVisible(tokenRef.current, visible);
        return () => setTokenVisible(tokenRef.current, false);
    }, [visible]);

    return null;
}
