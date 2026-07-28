// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// sessions.ts — crest-side accessor for the session repo. See
// docs/agent-runtime-architecture.md §4 for the storage model and
// docs/agent-dual-mode-design.html §9 for the SQLite carrier.
//
// Sessions live under {WAVETERM_CONFIG_HOME or ~/.config/crest{-dev}}/
// sessions/{encodedCwd}/{timestamp}_{id}.db — the cwd-grouped layout
// (matches pi-coding-agent / Aider / Claude Code: project = conversation
// context). The per-session carrier is a SQLite .db (SqliteSessionRepo);
// JSONL stays available as an interchange format via import/export.
// One repo for the whole process; per-pane AgentHarness instances build
// their own NodeExecutionEnv with the pane's actual cwd when tool
// execution is needed.

import * as os from "node:os";
import * as path from "node:path";

import { SqliteSessionRepo } from "@crest/agent/harness/session/sqlite-repo";
import type { JsonlSessionMetadata, Session, SessionDetailInfo } from "@crest/agent/harness/types";

// AgentSessionMeta from Go-generated TS types (frontend/types/gotypes.d.ts)
// is structurally a subset of pi's JsonlSessionMetadata. Field names
// match (Y1 camelCase decision, doc §7.2) so round-trip is identity.

let _repo: SqliteSessionRepo | undefined;

export interface ForkPaneSessionOptions {
    cwd?: string;
    entryId?: string;
    position?: "before" | "at";
    id?: string;
    parentSessionPath?: string;
}

/**
 * Resolve crest's per-user config home, mirroring the Go side's
 * GetWaveConfigDir logic (pkg/wavebase/wavebase.go:130). All of crest's
 * per-user AI state (ai.json, sessions/, skills/) lives under this one
 * tree.
 */
export function defaultConfigHome(): string {
    const override = process.env.WAVETERM_CONFIG_HOME;
    if (override) return override;
    const isDev = process.env.WAVETERM_DEV === "1";
    const dirName = isDev ? "crest-dev" : "crest";
    const xdg = process.env.XDG_CONFIG_HOME;
    return xdg ? path.join(xdg, dirName) : path.join(os.homedir(), ".config", dirName);
}

/**
 * Resolve the sessions root directory. Sessions sit beside ai.json
 * under the same config home so all of crest's per-user AI state is one
 * tree.
 */
export function defaultSessionsDir(): string {
    return path.join(defaultConfigHome(), "sessions");
}

/**
 * Process-wide SqliteSessionRepo. Lazily constructed against
 * defaultSessionsDir(). Tests can substitute via _setSessionsRepoForTests.
 */
export function getSessionsRepo(): SqliteSessionRepo {
    if (!_repo) {
        _repo = new SqliteSessionRepo({ sessionsRoot: defaultSessionsDir() });
    }
    return _repo;
}

/** Test-only escape hatch: swap in a custom repo (e.g. pointed at a tmp dir). */
export function _setSessionsRepoForTests(repo: SqliteSessionRepo | undefined): void {
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
export async function openPaneSession(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
    return getSessionsRepo().open(metadata);
}

export async function openPaneSessionByPath(sessionPath: string): Promise<Session<JsonlSessionMetadata>> {
    return getSessionsRepo().openPath(sessionPath);
}

export async function findPaneSessionById(sessionId: string): Promise<JsonlSessionMetadata | undefined> {
    return getSessionsRepo().findById(sessionId);
}

export async function renamePaneSession(sessionMetadata: JsonlSessionMetadata, name: string): Promise<void> {
    await getSessionsRepo().rename(sessionMetadata, name);
}

export async function archivePaneSession(sessionMetadata: JsonlSessionMetadata): Promise<JsonlSessionMetadata> {
    return await getSessionsRepo().archive(sessionMetadata);
}

export async function stageDeletePaneSession(sessionMetadata: JsonlSessionMetadata): Promise<JsonlSessionMetadata> {
    return await getSessionsRepo().stageDelete(sessionMetadata);
}

export async function restoreMovedPaneSession(
    movedSessionMetadata: JsonlSessionMetadata,
    originalPath: string
): Promise<void> {
    await getSessionsRepo().restoreMovedSession(movedSessionMetadata, originalPath);
}

export async function forkPaneSession(
    sourceMetadata: JsonlSessionMetadata,
    options: ForkPaneSessionOptions = {}
): Promise<{
    session: Session<JsonlSessionMetadata>;
    metadata: JsonlSessionMetadata;
}> {
    const session = await getSessionsRepo().fork(sourceMetadata, {
        ...options,
        cwd: options.cwd ?? sourceMetadata.cwd,
    });
    const metadata = await session.getMetadata();
    return { session, metadata };
}

/**
 * Import a JSONL session file into a fresh SQLite session for `cwd`.
 * Unlike the old file-copy import, this parses and replays the JSONL
 * (rejecting malformed / wrong-version files) into a new .db under the
 * sessions tree, then returns the live session + its metadata. JSONL is
 * an interchange format here, not the on-disk carrier (doc §9.1).
 */
export async function importPaneSessionFromJsonl(
    inputPath: string,
    cwd: string
): Promise<{
    session: Session<JsonlSessionMetadata>;
    metadata: JsonlSessionMetadata;
}> {
    const resolvedInputPath = path.resolve(cwd, inputPath);
    const session = await getSessionsRepo().importFromJsonl(resolvedInputPath, { cwd });
    const metadata = await session.getMetadata();
    return { session, metadata };
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

export async function listSessionDetailsForCwd(cwd: string, limit?: number): Promise<SessionDetailInfo[]> {
    return getSessionsRepo().listDetails({ cwd, limit });
}

export async function listAllSessionDetails(limit?: number): Promise<SessionDetailInfo[]> {
    return getSessionsRepo().listDetails({ limit });
}

export type { JsonlSessionMetadata, Session, SessionDetailInfo } from "@crest/agent/harness/types";
