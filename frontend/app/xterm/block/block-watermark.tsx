// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Ported from terax-ai BlockWatermark.tsx. terax read its watermark state
// straight from the useTerminalSession module; crest's xterm session
// registry isn't ported yet, so the state comes in through a getState prop
// (the same dependency-injection shape BlockOverlay uses). The shortcut
// hints are static: crest has no user-rebindable shortcut registry, so
// there is no useShortcutLabel equivalent to resolve labels from.

import logoSrc from "@/app/asset/logo.svg";
import { isMacOS } from "@/util/platformutil";
import { cn } from "@/util/util";
import { useEffect, useState, useSyncExternalStore } from "react";

export type WatermarkState = "visible" | "hidden" | "dead";

type Props = {
    subscribe: (cb: () => void) => () => void;
    getState: () => WatermarkState;
};

const NoopSubscribe = () => () => {};
const Dead = (): WatermarkState => "dead";

// First-run hints over an untouched block terminal. Once the leaf runs a
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

    const mod = isMacOS() ? "⌘" : "⌃";

    return (
        <div
            aria-hidden
            className={cn(
                "pointer-events-none absolute inset-0 z-[5] flex select-none flex-col items-center justify-center gap-8",
                "transition-[opacity,transform] duration-500 ease-out",
                state === "visible" ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
            )}
        >
            <img src={logoSrc} alt="" draggable={false} className="size-24 rounded-3xl shadow-lg shadow-black/25" />
            <div className="grid grid-cols-[auto_auto] items-center gap-x-12 gap-y-3 text-[13px]">
                <Hint label="Browse your command history" keys={["↑"]} />
                <Hint label="Autocomplete paths and commands" keys={["Tab"]} />
                <Hint label="Switch between Shell and AI" keys={[mod, "I"]} />
                <Hint label="Open the command palette" keys={[mod, "P"]} />
            </div>
        </div>
    );
}

function Hint({ label, keys }: { label: string; keys: string[] }) {
    return (
        <>
            <span className="justify-self-start text-muted-foreground/60">{label}</span>
            <span className="flex items-center gap-1 justify-self-end">
                {keys.map((k) => (
                    <Key key={k}>{k}</Key>
                ))}
            </span>
        </>
    );
}

function Key({ children }: { children: React.ReactNode }) {
    return (
        <kbd className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-md border border-border/45 bg-muted/30 px-1.5 font-sans text-[11px] font-medium text-muted-foreground/80">
            {children}
        </kbd>
    );
}
