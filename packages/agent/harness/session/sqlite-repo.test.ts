// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { SqliteSessionRepo } from "./sqlite-repo";

const CleanupRoots: string[] = [];

afterEach(async () => {
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("finds sessions recursively by id after archive and trash moves", async () => {
    const root = await mkdtemp(join(tmpdir(), "crest-sessions-"));
    CleanupRoots.push(root);
    const repo = new SqliteSessionRepo({ sessionsRoot: root });
    const active = await repo.create({ cwd: "/workspace", id: "active-id" });
    const archived = await repo.create({ cwd: "/workspace", id: "archive-id" });
    const trashed = await repo.create({ cwd: "/workspace", id: "trash-id" });
    const activeMetadata = await active.getMetadata();
    const archivedMetadata = await archived.getMetadata();
    const trashedMetadata = await trashed.getMetadata();
    active.close();
    archived.close();
    trashed.close();
    await repo.archive(archivedMetadata);
    await repo.stageDelete(trashedMetadata);

    expect((await repo.findById("active-id"))?.path).toBe(activeMetadata.path);
    expect((await repo.findById("archive-id"))?.id).toBe("archive-id");
    expect((await repo.findById("trash-id"))?.id).toBe("trash-id");
    expect((await repo.scanAllMetadata()).map((item) => item.id).sort()).toEqual([
        "active-id",
        "archive-id",
        "trash-id",
    ]);
});
