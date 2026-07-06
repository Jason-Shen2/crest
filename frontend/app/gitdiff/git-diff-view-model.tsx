// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { BlockNodeModel } from "@/app/block/blocktypes";
import type { TabModel } from "@/app/store/tab-model";
import type { WaveEnv } from "@/app/waveenv/waveenv";
import { atom, type Atom } from "jotai";
import { GitDiffPane } from "./git-diff-pane";

export class GitDiffViewModel implements ViewModel {
    readonly viewType = "gitdiff";
    readonly blockId: string;
    readonly nodeModel: BlockNodeModel;
    readonly tabModel: TabModel;
    readonly env: WaveEnv;
    readonly blockAtom: Atom<Block>;
    readonly viewIcon = atom("git-pull-request");
    readonly viewName = atom("Git Diff");
    readonly noPadding = atom(true);
    readonly viewComponent = GitDiffPane;

    constructor({ blockId, nodeModel, tabModel, waveEnv }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.tabModel = tabModel;
        this.env = waveEnv;
        this.blockAtom = this.env.wos.getWaveObjectAtom<Block>(`block:${blockId}`);
    }
}
