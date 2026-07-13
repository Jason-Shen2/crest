// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Icon } from "@/app/icon/Icon";
import { globalStore } from "@/app/store/jotaiStore";
import { ObjectService } from "@/app/store/services";
import { TerminalView } from "@/app/term/render/terminal-view";
import { getSettingsKeyAtom } from "@/store/global";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import * as jotai from "jotai";
import { useEffect } from "react";

type RightTerminalProps = {
    cwd?: string;
};

export class RightTerminalModel {
    private static instance: RightTerminalModel = null;

    readonly blockIdAtom = jotai.atom("");
    readonly errorAtom = jotai.atom("");

    private blockId = "";
    private cwd = "";
    private generation = 0;
    private startPromise: Promise<void> = null;

    private constructor() {}

    static getInstance(): RightTerminalModel {
        if (!RightTerminalModel.instance) {
            RightTerminalModel.instance = new RightTerminalModel();
        }
        return RightTerminalModel.instance;
    }

    static resetInstance(): void {
        RightTerminalModel.instance?.dispose();
        RightTerminalModel.instance = null;
    }

    ensureStarted(cwd?: string): void {
        const nextCwd = cwd ?? "";
        if (this.blockId && this.cwd === nextCwd) return;
        if (this.startPromise && this.cwd === nextCwd) return;
        if (this.blockId || this.startPromise) {
            this.dispose();
        }
        this.cwd = nextCwd;
        globalStore.set(this.errorAtom, "");

        const generation = this.generation;
        const promise = this.createBlock(nextCwd, generation);
        this.startPromise = promise;
        void promise.finally(() => {
            if (this.startPromise !== promise) return;
            this.startPromise = null;
        });
    }

    dispose(): void {
        this.generation++;
        const blockId = this.blockId;
        this.blockId = "";
        this.cwd = "";
        this.startPromise = null;
        globalStore.set(this.blockIdAtom, "");
        globalStore.set(this.errorAtom, "");
        if (!blockId) return;
        fireAndForget(() => ObjectService.DeleteBlock(blockId));
    }

    private async createBlock(cwd: string, generation: number): Promise<void> {
        try {
            const blockDef: BlockDef = {
                meta: {
                    controller: "shell",
                    view: "term",
                    ...(cwd ? { "cmd:cwd": cwd } : {}),
                },
            };
            const rtOpts: RuntimeOpts = { termsize: { rows: 24, cols: 80 } };
            const blockId = await ObjectService.CreateBlock(blockDef, rtOpts);
            if (generation !== this.generation) {
                fireAndForget(() => ObjectService.DeleteBlock(blockId));
                return;
            }
            this.blockId = blockId;
            globalStore.set(this.blockIdAtom, blockId);
        } catch (e: any) {
            if (generation !== this.generation) return;
            globalStore.set(this.errorAtom, e?.message ?? String(e));
        }
    }
}

export function RightTerminal({ cwd }: RightTerminalProps) {
    const model = RightTerminalModel.getInstance();
    const blockId = useAtomValue(model.blockIdAtom);
    const error = useAtomValue(model.errorAtom);
    const configuredFontSize = useAtomValue(getSettingsKeyAtom("term:fontsize"));
    const fontSize = typeof configuredFontSize === "number" ? configuredFontSize : 16;

    useEffect(() => {
        model.ensureStarted(cwd);
    }, [cwd, model]);

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
            <TerminalView outerBlockId={blockId} fontSize={fontSize} />
        </div>
    );
}
