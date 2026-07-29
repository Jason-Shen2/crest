// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { deriveWorkspaceApplyArtifactPaths, reconcileInterruptedCapturedPathArtifacts } from "./filesystem-apply";

function oid(bytes: Buffer): string {
    return createHash("sha1")
        .update(Buffer.from(`blob ${bytes.length}\0`))
        .update(bytes)
        .digest("hex");
}

describe("interrupted workspace apply artifact reconciliation", () => {
    it("cleans a prepared-only forward artifact while preserving the live pre-state", async () => {
        const value = await fixture();
        await writeFile(join(value.root, "file.txt"), value.pre);
        await writeFile(join(value.root, value.artifacts.preparedFile), value.target, { mode: 0o600 });

        await value.reconcile(value.preState, value.preState, value.targetState);

        await expect(readFile(join(value.root, "file.txt"))).resolves.toEqual(value.pre);
        await expect(readFile(join(value.root, value.artifacts.preparedFile))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("finishes rollback from prepared pre plus quarantined target and is idempotent", async () => {
        const value = await fixture();
        await writeFile(join(value.root, value.artifacts.preparedFile), value.pre, { mode: 0o600 });
        await mkdir(join(value.root, value.artifacts.quarantine), { mode: 0o700 });
        await writeFile(join(value.root, value.artifacts.quarantine, "entry"), value.target);

        await value.reconcile({ state: "absent" }, value.preState, value.targetState);
        await value.reconcile(value.preState, value.preState, value.targetState);

        await expect(readFile(join(value.root, "file.txt"))).resolves.toEqual(value.pre);
        expect(value.recovered).toHaveBeenCalledTimes(1);
    });

    it("restores quarantined pre over an installed target without retaining artifacts", async () => {
        const value = await fixture();
        await writeFile(join(value.root, "file.txt"), value.target);
        await mkdir(join(value.root, value.artifacts.quarantine), { mode: 0o700 });
        await writeFile(join(value.root, value.artifacts.quarantine, "entry"), value.pre);

        await value.reconcile(value.targetState, value.preState, value.targetState);

        await expect(readFile(join(value.root, "file.txt"))).resolves.toEqual(value.pre);
        await expect(readFile(join(value.root, value.artifacts.quarantine, "entry"))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("removes a prepared create when the desired pre-state is absent", async () => {
        const value = await fixture();
        await writeFile(join(value.root, value.artifacts.preparedFile), value.target, { mode: 0o600 });

        await value.reconcile({ state: "absent" }, { state: "absent" }, value.targetState);

        await expect(readFile(join(value.root, "file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(value.root, value.artifacts.preparedFile))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });

    it("makes no writes when a deterministic artifact has unknown bytes", async () => {
        const value = await fixture();
        const unknown = Buffer.from("unknown");
        await writeFile(join(value.root, "file.txt"), value.target);
        await writeFile(join(value.root, value.artifacts.preparedFile), unknown, { mode: 0o600 });

        await expect(value.reconcile(value.targetState, value.preState, value.targetState)).rejects.toThrow(/unknown/i);

        await expect(readFile(join(value.root, "file.txt"))).resolves.toEqual(value.target);
        await expect(readFile(join(value.root, value.artifacts.preparedFile))).resolves.toEqual(unknown);
        expect(value.recovered).not.toHaveBeenCalled();
    });

    it("installs a prepared symlink while discarding a quarantined target", async () => {
        const value = await fixture();
        const linkTarget = "relative-target";
        const desired = { state: "symlink" as const, oid: oid(Buffer.from(linkTarget)) };
        await symlink(linkTarget, join(value.root, value.artifacts.preparedSymlink));
        await mkdir(join(value.root, value.artifacts.quarantine), { mode: 0o700 });
        await writeFile(join(value.root, value.artifacts.quarantine, "entry"), value.target);

        await reconcileInterruptedCapturedPathArtifacts({
            root: value.root,
            path: "file.txt",
            live: { state: "absent" },
            desired,
            alternate: value.targetState,
            operationId: "operation-1",
            onPathRecovered: value.recovered,
        });

        await expect(readlink(join(value.root, "file.txt"))).resolves.toBe(linkTarget);
        expect(value.recovered).toHaveBeenCalledTimes(1);
    });

    it("freezes an ambiguous duplicate quarantine without changing either entry", async () => {
        const value = await fixture();
        await writeFile(join(value.root, "file.txt"), value.pre);
        await mkdir(join(value.root, value.artifacts.quarantine), { mode: 0o700 });
        await writeFile(join(value.root, value.artifacts.quarantine, "entry"), value.pre);

        await expect(value.reconcile(value.preState, value.preState, value.targetState)).rejects.toThrow(/duplicates/i);

        await expect(readFile(join(value.root, "file.txt"))).resolves.toEqual(value.pre);
        await expect(readFile(join(value.root, value.artifacts.quarantine, "entry"))).resolves.toEqual(value.pre);
    });

    it("cleans the prepared side of an interrupted hard-link install without deleting the live target", async () => {
        const value = await fixture();
        await writeFile(join(value.root, value.artifacts.preparedFile), value.target, { mode: 0o600 });
        await link(join(value.root, value.artifacts.preparedFile), join(value.root, "file.txt"));

        await value.reconcile(value.targetState, value.preState, value.targetState);

        await expect(readFile(join(value.root, "file.txt"))).resolves.toEqual(value.target);
        await expect(readFile(join(value.root, value.artifacts.preparedFile))).rejects.toMatchObject({
            code: "ENOENT",
        });
    });
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "crest-artifact-recovery-"));
    const pre = Buffer.from("pre");
    const target = Buffer.from("target");
    const preState = { state: "file" as const, oid: oid(pre), executable: false };
    const targetState = { state: "file" as const, oid: oid(target), executable: false };
    const artifacts = deriveWorkspaceApplyArtifactPaths({ operationId: "operation-1", path: "file.txt" });
    const recovered = vi.fn(async () => {});
    return {
        root,
        pre,
        target,
        preState,
        targetState,
        artifacts,
        recovered,
        reconcile: (
            live: typeof preState | typeof targetState | { state: "absent" },
            desired: typeof preState | { state: "absent" },
            alternate: typeof targetState
        ) =>
            reconcileInterruptedCapturedPathArtifacts({
                root,
                path: "file.txt",
                live,
                desired,
                alternate,
                operationId: "operation-1",
                onPathRecovered: recovered,
            }),
    };
}
