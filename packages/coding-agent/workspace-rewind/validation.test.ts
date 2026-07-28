// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decodeWorkspaceCheckpointV1, decodeWorkspaceStateV1 } from "./validation";

const OidA = "a".repeat(40);
const OidB = "b".repeat(40);
const FailureCodes = [
    "disabled",
    "git_unavailable",
    "capture_timeout",
    "capture_budget",
    "unstable_file",
    "enospc",
    "quota_exceeded",
    "hosted_pty_running",
    "process_crash_before_finalization",
    "corrupt_snapshot",
] as const;

function snapshot(id = OidA) {
    return {
        id,
        workspaceIdentity: "workspace-1",
        workspaceIncarnation: "incarnation-1",
        tree: OidA,
        scopeManifest: OidB,
    };
}

function coverage() {
    return {
        complete: true,
        eligibleEntryCount: 2,
        newlyHashedBytes: 12,
        exclusions: [],
    };
}

function encodedPath(bytes: number[]): string {
    return Buffer.from(bytes).toString("base64");
}

function availableCheckpoint() {
    return {
        schemaVersion: 1,
        status: "available",
        originSessionId: "session-1",
        turnId: "turn-1",
        workspaceIdentity: "workspace-1",
        workspaceIncarnation: "incarnation-1",
        before: snapshot(OidA),
        after: snapshot(OidB),
        changes: [
            {
                path: "src/index.ts",
                before: { state: "absent" },
                after: { state: "file", oid: OidA, executable: false },
            },
            {
                path: "bin/tool",
                before: { state: "symlink", oid: OidB },
                after: { state: "excluded", reason: "hard-linked" },
            },
        ],
        coverage: coverage(),
    };
}

function unavailableCheckpoint() {
    return {
        schemaVersion: 1,
        status: "unavailable",
        originSessionId: "session-1",
        turnId: "turn-1",
        workspaceIdentity: "workspace-1",
        workspaceIncarnation: "incarnation-1",
        reasonCode: "capture_timeout",
        message: "capture timed out",
        coverage: coverage(),
    };
}

function workspaceState(kind: "rewind" | "redo" = "rewind") {
    return {
        schemaVersion: 1,
        sessionId: "session-1",
        operationId: "operation-1",
        workspaceIdentity: "workspace-1",
        workspaceIncarnation: "incarnation-1",
        kind,
        applyMode: "normal",
        forcedPaths: ["src/forced.ts"],
        currentSnapshot: snapshot(OidA),
        currentStates: [
            { path: "src/index.ts", state: { state: "file", oid: OidA, executable: true } },
            { path: "deleted.txt", state: { state: "absent" } },
        ],
        rewind: {
            fromLeafId: "leaf-1",
            targetTurnId: "turn-1",
            targetBoundaryId: null,
            redoSnapshot: snapshot(OidB),
            redoStates: [{ path: "src/index.ts", state: { state: "symlink", oid: OidB } }],
        },
    };
}

describe("workspace rewind validation", () => {
    it("decodes available and unavailable checkpoint variants without changing their values", () => {
        const available = availableCheckpoint();
        const unavailable = unavailableCheckpoint();

        expect(decodeWorkspaceCheckpointV1(available)).toEqual(available);
        expect(decodeWorkspaceCheckpointV1(unavailable)).toEqual(unavailable);
    });

    it.each(FailureCodes)("round trips unavailable checkpoint reason %s", (reasonCode) => {
        const checkpoint = { ...unavailableCheckpoint(), reasonCode };

        expect(decodeWorkspaceCheckpointV1(checkpoint)).toEqual(checkpoint);
    });

    it("decodes rewind and redo workspace states without changing their values", () => {
        const rewind = workspaceState("rewind");
        const redo = workspaceState("redo");

        expect(decodeWorkspaceStateV1(rewind)).toEqual(rewind);
        expect(decodeWorkspaceStateV1(redo)).toEqual(redo);
    });

    it.each([
        ["checkpoint top level", { ...availableCheckpoint(), unexpected: true }],
        [
            "checkpoint variant",
            {
                ...availableCheckpoint(),
                coverage: { ...coverage(), unexpected: true },
            },
        ],
        [
            "captured path state",
            {
                ...availableCheckpoint(),
                changes: [
                    {
                        path: "src/index.ts",
                        before: { state: "absent", unexpected: true },
                        after: { state: "absent" },
                    },
                ],
            },
        ],
        ["workspace state top level", { ...workspaceState(), unexpected: true }],
        [
            "workspace state rewind payload",
            {
                ...workspaceState(),
                rewind: { ...workspaceState().rewind, unexpected: true },
            },
        ],
    ])("rejects unknown fields in %s", (_label, value) => {
        const decoded = _label.toString().startsWith("workspace state")
            ? decodeWorkspaceStateV1(value)
            : decodeWorkspaceCheckpointV1(value);
        expect(decoded).toBeUndefined();
    });

    it("rejects unsupported schema versions and unknown enum strings", () => {
        expect(decodeWorkspaceCheckpointV1({ ...availableCheckpoint(), schemaVersion: 2 })).toBeUndefined();
        expect(
            decodeWorkspaceCheckpointV1({ ...unavailableCheckpoint(), reasonCode: "temporary_failure" })
        ).toBeUndefined();
        expect(decodeWorkspaceStateV1({ ...workspaceState(), kind: "restore" })).toBeUndefined();
        expect(decodeWorkspaceStateV1({ ...workspaceState(), applyMode: "best-effort" })).toBeUndefined();
    });

    it.each([
        "",
        "/etc/passwd",
        "../secret",
        "src/../secret",
        "./src",
        "src\\..\\secret",
        "C:\\temp\\file",
        "src//file",
        "src/\0file",
    ])("rejects non-canonical workspace path %j", (path) => {
        expect(
            decodeWorkspaceCheckpointV1({
                ...availableCheckpoint(),
                changes: [{ path, before: { state: "absent" }, after: { state: "absent" } }],
            })
        ).toBeUndefined();
        expect(decodeWorkspaceStateV1({ ...workspaceState(), forcedPaths: [path] })).toBeUndefined();
    });

    it("rejects duplicate paths in every path-indexed collection", () => {
        const change = {
            path: "src/index.ts",
            before: { state: "absent" },
            after: { state: "absent" },
        };
        expect(
            decodeWorkspaceCheckpointV1({ ...availableCheckpoint(), changes: [change, { ...change }] })
        ).toBeUndefined();
        expect(
            decodeWorkspaceStateV1({
                ...workspaceState(),
                forcedPaths: ["src/index.ts", "src/index.ts"],
            })
        ).toBeUndefined();
        expect(
            decodeWorkspaceStateV1({
                ...workspaceState(),
                currentStates: [
                    { path: "src/index.ts", state: { state: "absent" } },
                    { path: "src/index.ts", state: { state: "absent" } },
                ],
            })
        ).toBeUndefined();
        expect(
            decodeWorkspaceStateV1({
                ...workspaceState(),
                rewind: {
                    ...workspaceState().rewind,
                    redoStates: [
                        { path: "src/index.ts", state: { state: "absent" } },
                        { path: "src/index.ts", state: { state: "absent" } },
                    ],
                },
            })
        ).toBeUndefined();
    });

    it.each(["A".repeat(40), "a".repeat(39), "g".repeat(40), "sha1:a".repeat(8)])(
        "rejects invalid Git object ID %j",
        (oid) => {
            expect(
                decodeWorkspaceCheckpointV1({
                    ...availableCheckpoint(),
                    before: { ...snapshot(OidA), tree: oid },
                })
            ).toBeUndefined();
            expect(
                decodeWorkspaceCheckpointV1({
                    ...availableCheckpoint(),
                    changes: [
                        {
                            path: "src/index.ts",
                            before: { state: "absent" },
                            after: { state: "file", oid, executable: false },
                        },
                    ],
                })
            ).toBeUndefined();
        }
    );

    it.each([
        [
            "available before snapshot",
            () => ({
                decode: decodeWorkspaceCheckpointV1,
                value: {
                    ...availableCheckpoint(),
                    before: { ...snapshot(OidA), id: "invalid-snapshot-id" },
                },
            }),
        ],
        [
            "available after snapshot",
            () => ({
                decode: decodeWorkspaceCheckpointV1,
                value: {
                    ...availableCheckpoint(),
                    after: { ...snapshot(OidB), id: "invalid-snapshot-id" },
                },
            }),
        ],
        [
            "workspace current snapshot",
            () => ({
                decode: decodeWorkspaceStateV1,
                value: {
                    ...workspaceState(),
                    currentSnapshot: { ...snapshot(OidA), id: "invalid-snapshot-id" },
                },
            }),
        ],
        [
            "workspace rewind redo snapshot",
            () => ({
                decode: decodeWorkspaceStateV1,
                value: {
                    ...workspaceState(),
                    rewind: {
                        ...workspaceState().rewind,
                        redoSnapshot: { ...snapshot(OidB), id: "invalid-snapshot-id" },
                    },
                },
            }),
        ],
    ])("rejects an invalid descriptor OID in %s", (_label, makeInput) => {
        const { decode, value } = makeInput();

        expect(decode(value)).toBeUndefined();
    });

    it("rejects invalid numeric bounds and malformed exclusion locators", () => {
        expect(
            decodeWorkspaceCheckpointV1({
                ...availableCheckpoint(),
                coverage: { ...coverage(), eligibleEntryCount: -1 },
            })
        ).toBeUndefined();
        expect(
            decodeWorkspaceCheckpointV1({
                ...availableCheckpoint(),
                coverage: {
                    ...coverage(),
                    exclusions: [{ path: "src/index.ts", pathBytesBase64: "c3Jj", reason: "ignored" }],
                },
            })
        ).toBeUndefined();
        expect(
            decodeWorkspaceCheckpointV1({
                ...availableCheckpoint(),
                coverage: {
                    ...coverage(),
                    exclusions: [{ pathBytesBase64: "***", reason: "non-utf8-path" }],
                },
            })
        ).toBeUndefined();
    });

    it.each([
        ["absolute path", encodedPath([...Buffer.from("/tmp/file")])],
        ["Windows drive prefix", encodedPath([...Buffer.from("C:/temp/file")])],
        ["backslash", encodedPath([...Buffer.from("src\\file")])],
        ["NUL", encodedPath([...Buffer.from("src/\0file")])],
        ["empty segment", encodedPath([...Buffer.from("src//file")])],
        ["dot segment", encodedPath([...Buffer.from("src/./file")])],
        ["dotdot segment", encodedPath([...Buffer.from("src/../file")])],
        ["empty path", encodedPath([])],
        ["non-canonical Base64", "Zh=="],
    ])("rejects encoded %s workspace path", (_label, pathBytesBase64) => {
        expect(
            decodeWorkspaceCheckpointV1({
                ...availableCheckpoint(),
                coverage: {
                    ...coverage(),
                    exclusions: [{ pathBytesBase64, reason: "non-utf8-path" }],
                },
            })
        ).toBeUndefined();
    });

    it("rejects equivalent text and raw-byte exclusion locators", () => {
        const path = "src/file";

        expect(
            decodeWorkspaceCheckpointV1({
                ...availableCheckpoint(),
                coverage: {
                    ...coverage(),
                    exclusions: [
                        { path, reason: "ignored" },
                        { pathBytesBase64: encodedPath([...Buffer.from(path)]), reason: "non-utf8-path" },
                    ],
                },
            })
        ).toBeUndefined();
    });

    it("accepts a canonical non-UTF-8 relative raw-byte path", () => {
        const checkpoint = {
            ...availableCheckpoint(),
            coverage: {
                ...coverage(),
                exclusions: [
                    {
                        pathBytesBase64: encodedPath([0xff, 0x2f, 0xfe]),
                        reason: "non-utf8-path",
                    },
                ],
            },
        };

        expect(decodeWorkspaceCheckpointV1(checkpoint)).toEqual(checkpoint);
    });

    it.each(["bad/\ud800", "bad/\udc00"])(
        "rejects unpaired UTF-16 surrogate path %j everywhere text paths occur",
        (path) => {
            expect(
                decodeWorkspaceCheckpointV1({
                    ...availableCheckpoint(),
                    changes: [{ path, before: { state: "absent" }, after: { state: "absent" } }],
                })
            ).toBeUndefined();
            expect(
                decodeWorkspaceCheckpointV1({
                    ...availableCheckpoint(),
                    coverage: {
                        ...coverage(),
                        exclusions: [{ path, reason: "ignored" }],
                    },
                })
            ).toBeUndefined();
            expect(decodeWorkspaceStateV1({ ...workspaceState(), forcedPaths: [path] })).toBeUndefined();
            expect(
                decodeWorkspaceStateV1({
                    ...workspaceState(),
                    currentStates: [{ path, state: { state: "absent" } }],
                })
            ).toBeUndefined();
            expect(
                decodeWorkspaceStateV1({
                    ...workspaceState(),
                    rewind: {
                        ...workspaceState().rewind,
                        redoStates: [{ path, state: { state: "absent" } }],
                    },
                })
            ).toBeUndefined();
        }
    );

    it("accepts a canonical emoji text path", () => {
        const path = "emoji/😀.txt";
        const checkpoint = {
            ...availableCheckpoint(),
            changes: [{ path, before: { state: "absent" }, after: { state: "absent" } }],
            coverage: {
                ...coverage(),
                exclusions: [{ path, reason: "ignored" }],
            },
        };
        const state = {
            ...workspaceState(),
            forcedPaths: [path],
            currentStates: [{ path, state: { state: "absent" } }],
            rewind: {
                ...workspaceState().rewind,
                redoStates: [{ path, state: { state: "absent" } }],
            },
        };

        expect(decodeWorkspaceCheckpointV1(checkpoint)).toEqual(checkpoint);
        expect(decodeWorkspaceStateV1(state)).toEqual(state);
    });
});
