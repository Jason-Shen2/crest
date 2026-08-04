// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { expectTypeOf, it } from "vitest";

import type { WorkspaceCheckpointSnapshotSource } from "./snapshot-source";
import type { WorkspaceSnapshotStore } from "./snapshot-store";

it("keeps the checkpoint snapshot source limited to capture and diff", () => {
    expectTypeOf<keyof WorkspaceCheckpointSnapshotSource>().toEqualTypeOf<"capture" | "diff">();
    expectTypeOf<WorkspaceSnapshotStore>().toMatchTypeOf<WorkspaceCheckpointSnapshotSource>();
});
