// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { TermBlocksViewModel } from "@/app/view/termblocks/termblocks";
import { TermViewModel } from "@/view/term/term-model";
import { registerBlockViewModel } from "./blockregistry";

export function registerTerminalBlockViewModels(): void {
    registerBlockViewModel("term", TermViewModel);
    registerBlockViewModel("termblocks", TermBlocksViewModel);
}
