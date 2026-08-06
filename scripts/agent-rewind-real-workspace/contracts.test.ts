// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { WorkspaceSnapshotStoreError } from "../../packages/coding-agent/workspace-rewind/snapshot-store";
import {
    AgentRewindResultDocument,
    classifyRepositorySupport,
    computeVerifiedProductCeiling,
    normalizeCaptureFailure,
    validateResultDocument,
} from "./contracts";

function makeResult(): AgentRewindResultDocument {
    return {
        schema: "agent-rewind-real-workspace-result",
        version: 1,
        environment: {
            platform: "linux",
            architecture: "x64",
            nodeversion: "22.0.0",
            baselinecommit: "a1980580",
        },
        repository: {
            input: "https://example.test/repository.git",
            fingerprint: "0123456789abcdef",
        },
        scope: {
            filecount: 100,
            bytecount: 10_000,
        },
        capture: {
            cold: {
                status: "completed",
                durationms: 100,
                filecount: 100,
                bytecount: 10_000,
                newbytes: 10_000,
            },
            warm: {
                status: "completed",
                durationms: 20,
                filecount: 100,
                bytecount: 10_000,
                newbytes: 10,
            },
        },
        scenarios: {
            undo: { status: "completed", durationms: 30 },
            redo: { status: "completed", durationms: 25 },
            exactbytes: { status: "completed", durationms: 5, matches: true },
        },
        resourcepeak: {
            rssbytes: 1_000_000,
            heapbytes: 500_000,
        },
        gitintegrity: {
            status: "completed",
            durationms: 10,
            clean: true,
        },
        sourceintegrity: {
            status: "completed",
            durationms: 10,
            clean: true,
        },
        cleanup: {
            status: "completed",
            durationms: 10,
        },
        support: "end-to-end-supported",
    };
}

describe("classifyRepositorySupport", () => {
    test("classifies a completed cold capture with an unavailable undo baseline as baseline-only", () => {
        const result = makeResult();
        result.scenarios.undo.status = "baseline-unavailable";
        result.scenarios.redo.status = "skipped";
        result.scenarios.exactbytes.status = "skipped";

        expect(classifyRepositorySupport(result)).toBe("baseline-only");
    });

    test("requires every end-to-end safety gate but does not require a warm capture", () => {
        const result = makeResult();
        result.capture.warm.status = "failed";

        expect(classifyRepositorySupport(result)).toBe("end-to-end-supported");

        const brokenResults = [
            (() => {
                const value = makeResult();
                value.capture.cold.status = "failed";
                return value;
            })(),
            (() => {
                const value = makeResult();
                value.scenarios.undo.status = "failed";
                return value;
            })(),
            (() => {
                const value = makeResult();
                value.scenarios.redo.status = "failed";
                return value;
            })(),
            (() => {
                const value = makeResult();
                value.scenarios.exactbytes.matches = false;
                return value;
            })(),
            (() => {
                const value = makeResult();
                value.gitintegrity.clean = false;
                return value;
            })(),
            (() => {
                const value = makeResult();
                value.sourceintegrity.clean = false;
                return value;
            })(),
            (() => {
                const value = makeResult();
                value.cleanup.status = "failed";
                return value;
            })(),
        ];

        expect(brokenResults.map(classifyRepositorySupport)).toEqual(brokenResults.map(() => "unsupported"));
    });
});

describe("normalizeCaptureFailure", () => {
    test("keeps timeout and budget failures as distinct typed outcomes", () => {
        expect(normalizeCaptureFailure(new WorkspaceSnapshotStoreError("capture_timeout", "deadline"))).toEqual({
            code: "capture_timeout",
            message: "deadline",
        });
        expect(normalizeCaptureFailure(new WorkspaceSnapshotStoreError("capture_budget", "too large"))).toEqual({
            code: "capture_budget",
            message: "too large",
        });
    });

    test("does not disguise unexpected failures as fail-closed capture outcomes", () => {
        expect(normalizeCaptureFailure(new Error("capture_timeout: socket failed"))).toEqual({
            code: "unexpected",
            message: "capture_timeout: socket failed",
        });
        expect(normalizeCaptureFailure({ code: "capture_budget", message: "forged" })).toEqual({
            code: "unexpected",
            message: "Unknown capture failure",
        });
    });
});

describe("computeVerifiedProductCeiling", () => {
    test("derives maxima only from repositories with verified end-to-end evidence", () => {
        const small = makeResult();
        const wide = makeResult();
        wide.repository.fingerprint = "wide";
        wide.scope.filecount = 500;
        wide.scope.bytecount = 8_000;

        const largeBaselineOnly = makeResult();
        largeBaselineOnly.repository.fingerprint = "large-baseline-only";
        largeBaselineOnly.scope.filecount = 50_000;
        largeBaselineOnly.scope.bytecount = 50_000_000;
        largeBaselineOnly.scenarios.undo.status = "baseline-unavailable";
        largeBaselineOnly.support = "end-to-end-supported";

        expect(computeVerifiedProductCeiling([small, wide, largeBaselineOnly])).toEqual({
            maxfilecount: 500,
            maxbytecount: 10_000,
        });
    });

    test("returns undefined when no repository has end-to-end evidence", () => {
        const result = makeResult();
        result.scenarios.undo.status = "baseline-unavailable";

        expect(computeVerifiedProductCeiling([result])).toBeUndefined();
    });
});

describe("validateResultDocument", () => {
    test("accepts a complete, internally consistent result with lowercase serialization fields", () => {
        const result = makeResult();
        const serialized = JSON.parse(JSON.stringify(result));
        const keys: string[] = [];
        const visit = (value: unknown): void => {
            if (Array.isArray(value)) {
                value.forEach(visit);
                return;
            }
            if (value == null || typeof value !== "object") return;
            for (const [key, child] of Object.entries(value)) {
                keys.push(key);
                visit(child);
            }
        };
        visit(serialized);

        expect(keys.every((key) => /^[a-z]+$/.test(key))).toBe(true);
        expect(validateResultDocument(serialized)).toEqual({ valid: true, errors: [] });
    });

    test.each([
        ["schema", { schema: "wrong" }],
        ["version", { version: 2 }],
    ])("rejects the wrong %s", (_name, replacement) => {
        const result = Object.assign(makeResult(), replacement);

        expect(validateResultDocument(result).valid).toBe(false);
    });

    test("rejects a result from a different baseline commit", () => {
        const result = makeResult();
        result.environment.baselinecommit = "different";

        expect(validateResultDocument(result).errors).toContain("environment.baselinecommit is not verified");
    });

    test("rejects a support claim that conflicts with measured evidence", () => {
        const result = makeResult();
        result.scenarios.undo.status = "baseline-unavailable";

        const validation = validateResultDocument(result);

        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain("support conflicts with repository evidence");
    });

    test("rejects missing critical safety evidence", () => {
        const result = makeResult() as unknown as Record<string, unknown>;
        delete result.sourceintegrity;

        const validation = validateResultDocument(result);

        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain("sourceintegrity is required");
    });
});
