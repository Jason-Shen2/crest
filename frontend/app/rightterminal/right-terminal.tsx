// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ObjectService } from "@/app/store/services";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { TerminalView } from "@/app/term/render/terminal-view";
import { cn, fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/app/icon/Icon";

type RightTerminalProps = {
    cwd?: string;
};

export function RightTerminal({ cwd }: RightTerminalProps) {
    const env = useWaveEnv();
    const [blockId, setBlockId] = useState<string | null>(null);
    const [error, setError] = useState<string>("");
    const blockIdRef = useRef<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const create = async () => {
            try {
                const blockDef: BlockDef = {
                    meta: {
                        controller: "shell",
                        view: "term",
                        ...(cwd ? { "cmd:cwd": cwd } : {}),
                    },
                };
                const rtOpts: RuntimeOpts = { termsize: { rows: 24, cols: 80 } };
                const id = await ObjectService.CreateBlock(blockDef, rtOpts);
                if (cancelled) {
                    fireAndForget(() => ObjectService.DeleteBlock(id));
                    return;
                }
                blockIdRef.current = id;
                setBlockId(id);
            } catch (e: any) {
                if (!cancelled) {
                    setError(e?.message ?? String(e));
                }
            }
        };
        void create();
        return () => {
            cancelled = true;
            const id = blockIdRef.current;
            if (id) {
                fireAndForget(() => ObjectService.DeleteBlock(id));
                blockIdRef.current = null;
            }
        };
    }, [cwd]);

    if (error) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                <Icon name="alert-02" size={14} className="text-xl text-rose-400" />
                <div className="text-sm text-primary">Failed to create terminal</div>
                <div className="max-w-xs text-xs text-secondary">{error}</div>
            </div>
        );
    }

    if (!blockId) {
        return (
            <div className="flex h-full items-center justify-center text-[12px] text-secondary/70">
                <div className="flex items-center gap-2">
                    <Icon name="loading-03" size={14} className="" spin />
                    <span>Starting terminal…</span>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full min-h-0 flex-col bg-panel">
            <TerminalView outerBlockId={blockId} fontSize={13} />
        </div>
    );
}
