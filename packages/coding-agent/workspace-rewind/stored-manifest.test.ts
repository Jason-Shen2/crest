// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
    encodeCanonicalStoredJson,
    StoredManifestReader,
    toStoredWorkspaceScope,
    type StoredManifestObjectReader,
    type StoredScopeManifest,
} from "./stored-manifest";
import type { WorkspaceSnapshotRefV1 } from "./types";
import type { WorkspaceScopeManifest } from "./workspace-scope";

const WorkspaceIdentity = "a".repeat(64);
const WorkspaceIncarnation = "b".repeat(64);

describe("stored snapshot manifests", () => {
    test("rejects superseded manifests with custom file-state authority", async () => {
        const objects = new MemoryObjects();
        const legacyEntryManifest = objects.put({
            schemaversion: 1,
            workspaceidentity: WorkspaceIdentity,
            workspaceincarnation: WorkspaceIncarnation,
            scope: toStoredWorkspaceScope(makeScope()),
            entries: [],
        });
        const legacyTreeManifest = objects.put({
            schemaversion: 2,
            workspaceidentity: WorkspaceIdentity,
            workspaceincarnation: WorkspaceIncarnation,
            scope: toStoredWorkspaceScope(makeScope()),
            coverage: { complete: true, eligibleentrycount: 0, exclusions: [] },
            state: "1".repeat(40),
        });

        await expect(openReader(objects, legacyEntryManifest)).rejects.toThrow(/v3|unsupported/i);
        await expect(openReader(objects, legacyTreeManifest)).rejects.toThrow(/v3|unsupported/i);
    });

    test("opens only compact canonical coverage and scope metadata", async () => {
        const objects = new MemoryObjects();
        const scope = makeScope();
        scope.ignoreInputs = [{ source: "gitignore", path: ".gitignore", contentHash: "c".repeat(64) }];
        scope.nestedRepositoryBoundaries = [{ path: "vendor/repository" }];
        const manifest = makeManifest(scope);
        manifest.coverage = {
            complete: false,
            eligibleentrycount: 7,
            exclusions: [
                { path: "ignored", reason: "ignored" },
                { pathbytesbase64: Buffer.from([0xff]).toString("base64"), reason: "non-utf8-path" },
            ],
        };
        const reader = await openReader(objects, objects.put(manifest));

        expect(reader.manifest).toEqual(manifest);
        expect(reader.getScope()).toEqual(scope);
        expect(reader.getCoverage()).toEqual({
            complete: false,
            eligibleEntryCount: 7,
            exclusions: [
                { path: "ignored", reason: "ignored" },
                { pathBytesBase64: "/w==", reason: "non-utf8-path" },
            ],
        });
        await expect(reader.verify()).resolves.toEqual({ workspaceStates: new Map(), objectIds: new Set() });
    });

    test("resolves path and root coverage exclusions without storing file states", async () => {
        const objects = new MemoryObjects();
        const manifest = makeManifest(makeScope());
        manifest.coverage = {
            complete: false,
            eligibleentrycount: 0,
            exclusions: [
                { path: "ignored", reason: "ignored" },
                { scope: "workspace-root", reason: "capture-budget" },
            ],
        };
        const reader = await openReader(objects, objects.put(manifest));

        await expect(reader.readCoveragePathState("ignored/child.txt")).resolves.toEqual({
            state: "excluded",
            reason: "ignored",
        });
        await expect(reader.readCoveragePathState("other.txt")).resolves.toEqual({
            state: "excluded",
            reason: "capture-budget",
        });
    });

    test("rejects non-canonical bytes and foreign Workspace identity", async () => {
        const objects = new MemoryObjects();
        const manifest = makeManifest(makeScope());
        const pretty = objects.putBytes(Buffer.from(JSON.stringify(manifest, null, 2)));

        await expect(openReader(objects, pretty)).rejects.toThrow(/canonical/i);

        const canonical = objects.put(manifest);
        await expect(
            StoredManifestReader.open({
                snapshot: { ...makeSnapshot(canonical), workspaceIdentity: "d".repeat(64) },
                objects,
            })
        ).rejects.toThrow(/identity mismatch/i);
    });
});

function makeManifest(scope: WorkspaceScopeManifest): StoredScopeManifest {
    return {
        schemaversion: 3,
        workspaceidentity: WorkspaceIdentity,
        workspaceincarnation: WorkspaceIncarnation,
        scope: toStoredWorkspaceScope(scope),
        coverage: { complete: true, eligibleentrycount: 0, exclusions: [] },
    };
}

function makeScope(): WorkspaceScopeManifest {
    return {
        schemaVersion: 1,
        policy: {
            maxEntries: 200_000,
            maxUntrackedBytes: 2 * 1024 * 1024,
            gitGlobalExcludes: "disabled-by-isolated-runner",
        },
        ignoreInputs: [],
        nestedRepositoryBoundaries: [],
    };
}

function openReader(objects: MemoryObjects, scopeManifest: string): Promise<StoredManifestReader> {
    return StoredManifestReader.open({ snapshot: makeSnapshot(scopeManifest), objects });
}

function makeSnapshot(scopeManifest: string): WorkspaceSnapshotRefV1 {
    return {
        id: "d".repeat(40),
        workspaceIdentity: WorkspaceIdentity,
        workspaceIncarnation: WorkspaceIncarnation,
        tree: "0".repeat(40),
        scopeManifest,
    };
}

class MemoryObjects implements StoredManifestObjectReader {
    readonly blobs = new Map<string, Buffer>();

    put(value: unknown): string {
        return this.putBytes(encodeCanonicalStoredJson(value));
    }

    putBytes(bytes: Buffer): string {
        const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        this.blobs.set(oid, bytes);
        return oid;
    }

    async readBlob(oid: string): Promise<Buffer> {
        const value = this.blobs.get(oid);
        if (!value) throw new Error("missing object");
        return value;
    }
}
