// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// sessions.ts — crest-side accessor for pi's JsonlSessionRepo. See
// docs/agent-runtime-architecture.md §4 for the storage model and §7.3
// for why we use pi's repo directly instead of a custom store.
//
// Sessions live under {WAVETERM_CONFIG_HOME or ~/.config/crest{-dev}}/
// sessions/{encodedCwd}/{timestamp}_{id}.jsonl — pi's cwd-grouped
// layout (matches pi-coding-agent / Aider / Claude Code: project =
// conversation context). One repo for the whole process; the env it
// holds is FS-only (no execution), so its cwd is irrelevant. Per-pane
// AgentHarness instances build their own NodeExecutionEnv with the
// pane's actual cwd when tool execution is needed.

import * as os from "node:os";
import * as path from "node:path";

import { JsonlSessionRepo } from "./harness/session/jsonl-repo";
import type { JsonlSessionMetadata, Session } from "./harness/types";
import { NodeExecutionEnv } from "./node";

// AgentSessionMeta from Go-generated TS types (frontend/types/gotypes.d.ts)
// is structurally a subset of pi's JsonlSessionMetadata. Field names
// match (Y1 camelCase decision, doc §7.2) so round-trip is identity.

let _repo: JsonlSessionRepo | undefined;

/**
 * Resolve the sessions root directory mirroring the Go side's
 * GetWaveConfigDir logic (pkg/wavebase/wavebase.go:130). Sessions
 * sit beside ai.json under the same config home so all of crest's
 * per-user AI state is one tree.
 */
export function defaultSessionsDir(): string {
    const override = process.env.WAVETERM_CONFIG_HOME;
    if (override) return path.join(override, "sessions");
    const isDev = process.env.WAVETERM_DEV === "1";
    const dirName = isDev ? "crest-dev" : "crest";
    const xdg = process.env.XDG_CONFIG_HOME;
    const root = xdg ? path.join(xdg, dirName) : path.join(os.homedir(), ".config", dirName);
    return path.join(root, "sessions");
}

/**
 * Process-wide JsonlSessionRepo. Lazily constructed against
 * defaultSessionsDir(). Tests can substitute via _setSessionsRepoForTests.
 */
export function getSessionsRepo(): JsonlSessionRepo {
    if (!_repo) {
        // The env attached to the repo is used only by JsonlSessionRepo
        // for filesystem bookkeeping (joinPath/createDir/listDir/...);
        // its cwd never matters because we pass absolute paths through
        // the repo API. process.cwd() is a benign default.
        const env = new NodeExecutionEnv({ cwd: process.cwd() });
        _repo = new JsonlSessionRepo({ fs: env, sessionsRoot: defaultSessionsDir() });
    }
    return _repo;
}

/** Test-only escape hatch: swap in a custom repo (e.g. pointed at a tmp dir). */
export function _setSessionsRepoForTests(repo: JsonlSessionRepo | undefined): void {
    _repo = repo;
}

/**
 * Mint a fresh session for a pane's cwd. Returns both the live pi Session
 * (used to construct an AgentHarness) and the metadata object that goes
 * into block.meta["agent:session"] so the renderer can re-open the same
 * session across remounts / app restarts.
 */
export async function createPaneSession(cwd: string): Promise<{
    session: Session<JsonlSessionMetadata>;
    metadata: JsonlSessionMetadata;
}> {
    const repo = getSessionsRepo();
    const session = await repo.create({ cwd });
    const metadata = await session.getMetadata();
    return { session, metadata };
}

/**
 * Re-open an existing session given its persisted metadata. Throws
 * SessionError("not_found") when the JSONL file vanished (project
 * moved, user deleted, etc.) — caller decides whether to fall back to
 * minting a new session or surface a "this conversation is gone" UX.
 *
 * Accepts any structural subset of JsonlSessionMetadata so the
 * AgentSessionMeta shape produced by Go round-trips without
 * translation (doc §5.1).
 */
export async function openPaneSession(
    metadata: JsonlSessionMetadata,
): Promise<Session<JsonlSessionMetadata>> {
    return getSessionsRepo().open(metadata);
}

export async function openPaneSessionByPath(
    sessionPath: string,
): Promise<Session<JsonlSessionMetadata>> {
    return getSessionsRepo().openPath(sessionPath);
}

/**
 * List recent sessions for a cwd, newest first (sorted by pi's repo).
 * Used by the "you have past conversations in this project" banner
 * (doc §6.1). Empty array when there are none — caller should hide
 * the banner in that case rather than render an empty list.
 */
export async function listSessionsForCwd(cwd: string): Promise<JsonlSessionMetadata[]> {
    return getSessionsRepo().list({ cwd });
}

export type { JsonlSessionMetadata, Session } from "./harness/types";
