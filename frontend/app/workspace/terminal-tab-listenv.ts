// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { WaveEnv, WaveEnvSubset } from "@/app/waveenv/waveenv";

export type TerminalTabListEnv = WaveEnvSubset<{
    wos: {
        useWaveObjectValue: WaveEnv["wos"]["useWaveObjectValue"];
    };
}>;
