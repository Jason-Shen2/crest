// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

export type BlockMeta = {
    id: string;
    command: string;
    cwd: string;
    exitCode: number | null;
    startLine: number;
    endLine: number;
    startedAt: number;
    finishedAt: number;
};
