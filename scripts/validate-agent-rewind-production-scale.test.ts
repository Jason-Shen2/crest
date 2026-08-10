// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { measureAgentRewindProductionRepository } from "./validate-agent-rewind-production-scale";

const CleanupRoots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
    await Promise.all(CleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("agent rewind V3 production repository validation", () => {
    test("keeps the source repository unchanged and removes the private authority", async () => {
        const root = await mkdtemp(join(tmpdir(), "crest-production-validation-test-"));
        CleanupRoots.push(root);
        const workspace = join(root, "workspace");
        await mkdir(workspace);
        await writeFile(join(workspace, "a.txt"), "a\n");
        await writeFile(join(workspace, "b.txt"), "b\n");
        await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
        await execFileAsync("git", ["add", "--all"], { cwd: workspace });
        await execFileAsync(
            "git",
            [
                "-c",
                "user.name=Crest Validation",
                "-c",
                "user.email=validation@crest.invalid",
                "commit",
                "--quiet",
                "-m",
                "fixture",
            ],
            { cwd: workspace }
        );

        const observation = await measureAgentRewindProductionRepository(workspace);

        expect(observation.sourceunchanged).toBe(true);
        expect(observation.sourcefingerprintafter).toBe(observation.sourcefingerprintbefore);
        expect(observation.cleanupcomplete).toBe(true);
        expect(observation.refsconsistent, JSON.stringify(observation)).toBe(true);
        expect(observation.cold.outcome).toBe("pass");
        expect(observation.cold.fallbackcount).toBe(0);
        expect(observation.cold.bytesread).toBe(0);
        expect(observation.warmnochange.outcome).toBe("pass");
        expect(observation.warmnochange.bytesread).toBe(0);
        expect(observation.warmfoursessions.outcome).toBe("pass");
        expect(observation.warmfoursessions.fallbackcount).toBe(0);
    }, 30_000);
});
