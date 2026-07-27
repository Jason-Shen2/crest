// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Ported from terax-ai BlockWatermark.tsx. terax read its watermark state
// straight from the useTerminalSession module; crest's xterm session
// registry isn't ported yet, so the state comes in through a getState prop
// (the same dependency-injection shape BlockOverlay uses). The centered
// content restores Crest's original empty-terminal welcome.

import { Icon } from "@/app/icon/Icon";
import { cn } from "@/util/util";
import { useEffect, useState, useSyncExternalStore } from "react";

export type WatermarkState = "visible" | "hidden" | "dead";

type Props = {
    subscribe: (cb: () => void) => () => void;
    getState: () => WatermarkState;
};

const NoopSubscribe = () => () => {};
const Dead = (): WatermarkState => "dead";

// First-run welcome over an untouched block terminal. Once the leaf runs a
// command the component unmounts for good and drops its subscription.
export function BlockWatermark({ subscribe, getState }: Props) {
    const [gone, setGone] = useState(false);
    const state = useSyncExternalStore(gone ? NoopSubscribe : subscribe, gone ? Dead : getState);

    useEffect(() => {
        if (gone || state !== "dead") return;
        const t = setTimeout(() => setGone(true), 600);
        return () => clearTimeout(t);
    }, [state, gone]);

    if (gone) return null;

    return (
        <div
            aria-hidden
            className={cn(
                "pointer-events-none absolute inset-0 z-[5] flex select-none flex-col items-center justify-center px-4 text-center text-current",
                "transition-[opacity,transform] duration-500 ease-out",
                state === "visible" ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
            )}
        >
            <div data-icon-name="computer-terminal-02" className="mb-3 text-current">
                <Icon name="computer-terminal-02" size={28} strokeWidth={1.75} className="opacity-70" />
            </div>
            <h1 className="text-lg font-semibold text-current">Run your first command</h1>
            <p className="mt-1 text-sm text-current/60">Type below to start a terminal session.</p>
        </div>
    );
}
