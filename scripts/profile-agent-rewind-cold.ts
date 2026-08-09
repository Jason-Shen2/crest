// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { profileAgentRewindColdBaseline, type FixtureShape } from "./benchmark-agent-rewind-snapshots";

const entryCount = Number(process.argv[2]);
const shape = process.argv[3] as FixtureShape;
if (!Number.isSafeInteger(entryCount) || entryCount < 2 || (shape !== "deep" && shape !== "wide")) {
    throw new Error("Usage: tsx scripts/profile-agent-rewind-cold.ts <entries> <deep|wide>");
}

console.log(JSON.stringify(await profileAgentRewindColdBaseline(entryCount, shape), null, 2));
