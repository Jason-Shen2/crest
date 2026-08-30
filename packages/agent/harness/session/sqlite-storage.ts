// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// sqlite-storage.ts — a SessionStorage implementation backed by Node's
// built-in `node:sqlite` (via the SqliteDb wrapper). It is a drop-in
// alternative to JsonlSessionStorage: the on-disk carrier changes from a
// JSONL file to a single-session SQLite database, but the SessionStorage
// contract (and therefore Session / buildContext / harness) is unchanged.
//
// Storage model: ONE .db file per session (path points at the .db, exactly
// like JsonlSessionStorage's path points at the .jsonl). Layout:
//
//   session_header  one row: version=3, id, timestamp, cwd, parent_session
//   entries         append-only log, one row per SessionTreeEntry:
//                     seq        INTEGER PK AUTOINCREMENT (insertion order)
//                     id         TEXT UNIQUE  (entry id)
//                     parent_id  TEXT NULL    (parentId chain)
//                     type       TEXT         (SessionTreeEntry["type"])
//                     timestamp  TEXT
//                     target_id  TEXT NULL    (leaf.targetId / label.targetId)
//                     data       TEXT         (JSON.stringify(entry), exact)
//
// Unlike JSONL, queries hit SQLite directly instead of loading the whole
// file into memory, so opening a long conversation is no longer O(file_size).
// See docs/agent-dual-mode-design.html §9.

import type { JsonlSessionMetadata, LeafEntry, SessionAppendOptions, SessionStorage, SessionTreeEntry } from "../types";
import { assertExpectedSessionLeaf, SessionError, toError } from "../types";
import { SqliteDb } from "./sqlite-driver";
import { uuidv7 } from "./uuid";
import { validateSessionEntriesForAppend } from "./entry-transaction";

const SCHEMA_VERSION = 3;

export interface HeaderRow {
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	parent_session: string | null;
}

function invalidSession(location: string, message: string, cause?: Error): SessionError {
	return new SessionError("invalid_session", `Invalid SQLite session ${location}: ${message}`, cause);
}

function leafIdAfterRow(row: { type: string; id: string; target_id: string | null }): string | null {
	return row.type === "leaf" ? row.target_id : row.id;
}

function deserializeEntry(row: { data: string }, location: string): SessionTreeEntry {
	try {
		return JSON.parse(row.data) as SessionTreeEntry;
	} catch (error) {
		throw invalidSession(location, "stored entry is not valid JSON", toError(error));
	}
}

function targetIdOf(entry: SessionTreeEntry): string | null {
	if (entry.type === "leaf") return entry.targetId;
	if (entry.type === "label") return entry.targetId;
	return null;
}

export interface SqliteSessionCreateOptions {
	cwd: string;
	sessionId: string;
	parentSessionPath?: string;
}

export function headerToSessionMetadata(header: HeaderRow, path: string): JsonlSessionMetadata {
	return {
		id: header.id,
		createdAt: header.timestamp,
		cwd: header.cwd,
		path,
		parentSessionPath: header.parent_session ?? undefined,
	};
}

const CREATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_header (
  rowid          INTEGER PRIMARY KEY CHECK (rowid = 1),
  version        INTEGER NOT NULL,
  id             TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  cwd            TEXT NOT NULL,
  parent_session TEXT
);
CREATE TABLE IF NOT EXISTS entries (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  parent_id  TEXT,
  type       TEXT NOT NULL,
  timestamp  TEXT NOT NULL,
  target_id  TEXT,
  data       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_type ON entries(type);
CREATE INDEX IF NOT EXISTS idx_entries_target ON entries(target_id);
`;

export class SqliteSessionStorage implements SessionStorage<JsonlSessionMetadata> {
	private readonly db: SqliteDb;
	private readonly location: string;
	private readonly metadata: JsonlSessionMetadata;
	private entryIds: Set<string> | undefined;
	private transactionIds: Set<string> | undefined;
	private lastIndexedSeq = 0;

	private constructor(db: SqliteDb, location: string, header: HeaderRow) {
		this.db = db;
		this.location = location;
		this.metadata = headerToSessionMetadata(header, location);
	}

	static open(filePath: string): SqliteSessionStorage {
		let db: SqliteDb;
		try {
			db = new SqliteDb(filePath);
		} catch (error) {
			// A non-SQLite file (e.g. a stray .jsonl renamed to .db, or random
			// bytes) can fail at open time. Treat it as a malformed session.
			throw invalidSession(filePath, "not a valid SQLite database", toError(error));
		}
		let header: HeaderRow | undefined;
		try {
			header = db.get<HeaderRow>(
				"SELECT version, id, timestamp, cwd, parent_session FROM session_header WHERE rowid = 1",
			);
		} catch (error) {
			// A fresh/empty .db has no session_header table → "no such table".
			// A non-SQLite .db can also fail here ("file is not a database").
			// Treat any read failure here as a malformed session file.
			db.close();
			throw invalidSession(filePath, "missing session header", toError(error));
		}
		if (!header) {
			db.close();
			throw invalidSession(filePath, "missing session header");
		}
		if (header.version !== SCHEMA_VERSION) {
			db.close();
			throw invalidSession(filePath, `unsupported session version ${header.version}`);
		}
		return new SqliteSessionStorage(db, filePath, header);
	}

	static create(filePath: string, options: SqliteSessionCreateOptions): SqliteSessionStorage {
		const db = new SqliteDb(filePath);
		db.exec(CREATE_SCHEMA);
		const timestamp = new Date().toISOString();
		db.run(
			"INSERT INTO session_header (rowid, version, id, timestamp, cwd, parent_session) VALUES (1, ?, ?, ?, ?, ?)",
			SCHEMA_VERSION,
			options.sessionId,
			timestamp,
			options.cwd,
			options.parentSessionPath ?? null,
		);
		const header: HeaderRow = {
			version: SCHEMA_VERSION,
			id: options.sessionId,
			timestamp,
			cwd: options.cwd,
			parent_session: options.parentSessionPath ?? null,
		};
		return new SqliteSessionStorage(db, filePath, header);
	}

	/** Best-effort handle release. */
	close(): void {
		this.db.close();
	}

	private hasEntryId(id: string): boolean {
		if (this.entryIds?.has(id)) return true;
		return this.db.get("SELECT 1 AS x FROM entries WHERE id = ? LIMIT 1", id) !== undefined;
	}

	private readAppendIndexDelta(
		afterSeq: number,
		throughSeq: number,
	): { entryIds: Set<string>; transactionIds: Set<string> } {
		const entryIds = new Set<string>();
		const transactionIds = new Set<string>();
		const rows = this.db.all<{ seq: number; data: string }>(
			"SELECT seq, data FROM entries WHERE seq > ? AND seq <= ? ORDER BY seq",
			afterSeq,
			throughSeq,
		);
		for (const row of rows) {
			const entry = deserializeEntry(row, this.location);
			entryIds.add(entry.id);
			if (entry.transactionId != null) transactionIds.add(entry.transactionId);
		}
		return { entryIds, transactionIds };
	}

	private generateEntryId(): string {
		for (let i = 0; i < 100; i++) {
			const id = uuidv7().slice(0, 8);
			if (!this.hasEntryId(id)) return id;
		}
		return uuidv7();
	}

	private insertEntry(entry: SessionTreeEntry): number {
		const result = this.db.run(
			"INSERT INTO entries (id, parent_id, type, timestamp, target_id, data) VALUES (?, ?, ?, ?, ?, ?)",
			entry.id,
			entry.parentId,
			entry.type,
			entry.timestamp,
			targetIdOf(entry),
			JSON.stringify(entry),
		);
		return Number(result.lastInsertRowid);
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return this.metadata;
	}

	async getLeafId(): Promise<string | null> {
		const last = this.db.get<{ type: string; id: string; target_id: string | null }>(
			"SELECT type, id, target_id FROM entries ORDER BY seq DESC LIMIT 1",
		);
		if (!last) return null;
		const leafId = leafIdAfterRow(last);
		if (leafId !== null && !this.hasEntryId(leafId)) {
			throw invalidSession(this.location, `Entry ${leafId} not found`);
		}
		return leafId;
	}

	async setLeafId(leafId: string | null): Promise<void> {
		if (leafId !== null && !this.hasEntryId(leafId)) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		const entry: LeafEntry = {
			type: "leaf",
			id: this.generateEntryId(),
			parentId: await this.getLeafId(),
			timestamp: new Date().toISOString(),
			targetId: leafId,
		};
		await this.appendEntry(entry);
	}

	async createEntryId(): Promise<string> {
		return this.generateEntryId();
	}

	async appendEntry(entry: SessionTreeEntry): Promise<void> {
		return this.appendEntries([entry]);
	}

	async appendEntries(entries: SessionTreeEntry[], options?: SessionAppendOptions): Promise<void> {
		const cacheUpdate = this.db.transaction(() => {
			const last = this.db.get<{ seq: number; type: string; id: string; target_id: string | null }>(
				"SELECT seq, type, id, target_id FROM entries ORDER BY seq DESC LIMIT 1",
			);
			const currentMaxSeq = last?.seq ?? 0;
			const currentLeafId = last == null ? null : leafIdAfterRow(last);
			assertExpectedSessionLeaf(options, currentLeafId);
			const reuseCache =
				this.entryIds != null && this.transactionIds != null && this.lastIndexedSeq <= currentMaxSeq;
			const baseEntryIds = reuseCache ? this.entryIds! : new Set<string>();
			const baseTransactionIds = reuseCache ? this.transactionIds! : new Set<string>();
			const indexedSeq = reuseCache ? this.lastIndexedSeq : 0;
			const delta =
				indexedSeq === currentMaxSeq
					? { entryIds: new Set<string>(), transactionIds: new Set<string>() }
					: this.readAppendIndexDelta(indexedSeq, currentMaxSeq);
			const authoritativeEntryIds = {
				has: (id: string) => baseEntryIds.has(id) || delta.entryIds.has(id),
			};
			const authoritativeTransactionIds = {
				has: (id: string) => baseTransactionIds.has(id) || delta.transactionIds.has(id),
			};
			if (currentLeafId !== null && !authoritativeEntryIds.has(currentLeafId)) {
				throw invalidSession(this.location, `Entry ${currentLeafId} not found`);
			}
			validateSessionEntriesForAppend(authoritativeEntryIds, authoritativeTransactionIds, entries);
			let nextIndexedSeq = currentMaxSeq;
			for (const entry of entries) {
				nextIndexedSeq = this.insertEntry(entry);
				delta.entryIds.add(entry.id);
				if (entry.transactionId != null) delta.transactionIds.add(entry.transactionId);
			}
			return { reset: !reuseCache, ...delta, lastIndexedSeq: nextIndexedSeq };
		});
		const nextEntryIds = cacheUpdate.reset ? new Set<string>() : this.entryIds!;
		const nextTransactionIds = cacheUpdate.reset ? new Set<string>() : this.transactionIds!;
		for (const id of cacheUpdate.entryIds) nextEntryIds.add(id);
		for (const id of cacheUpdate.transactionIds) nextTransactionIds.add(id);
		this.entryIds = nextEntryIds;
		this.transactionIds = nextTransactionIds;
		this.lastIndexedSeq = cacheUpdate.lastIndexedSeq;
	}

	async getEntry(id: string): Promise<SessionTreeEntry | undefined> {
		const row = this.db.get<{ data: string }>("SELECT data FROM entries WHERE id = ? LIMIT 1", id);
		return row ? deserializeEntry(row, this.location) : undefined;
	}

	async findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>> {
		const rows = this.db.all<{ data: string }>("SELECT data FROM entries WHERE type = ? ORDER BY seq", type);
		return rows.map((row) => deserializeEntry(row, this.location)) as Array<Extract<SessionTreeEntry, { type: TType }>>;
	}

	async getLabel(id: string): Promise<string | undefined> {
		const row = this.db.get<{ data: string }>(
			"SELECT data FROM entries WHERE type = 'label' AND target_id = ? ORDER BY seq DESC LIMIT 1",
			id,
		);
		if (!row) return undefined;
		const entry = deserializeEntry(row, this.location);
		if (entry.type !== "label") return undefined;
		const label = entry.label?.trim();
		return label ? label : undefined;
	}

	async getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]> {
		if (leafId === null) return [];
		const rows = this.db.all<{ data: string; parent_id: string | null; depth: number }>(
			`WITH RECURSIVE branch(data, parent_id, depth) AS (
				SELECT data, parent_id, 0 FROM entries WHERE id = ?
				UNION ALL
				SELECT entries.data, entries.parent_id, branch.depth + 1
				FROM entries
				JOIN branch ON entries.id = branch.parent_id
			)
			SELECT data, parent_id, depth FROM branch ORDER BY depth`,
			leafId,
		);
		if (rows.length === 0) {
			throw new SessionError("not_found", `Entry ${leafId} not found`);
		}
		const oldest = rows[rows.length - 1];
		if (oldest.parent_id) {
			throw invalidSession(this.location, `Entry ${oldest.parent_id} not found`);
		}
		rows.reverse();
		return rows.map((row) => deserializeEntry(row, this.location));
	}

	async getEntries(): Promise<SessionTreeEntry[]> {
		return this.getEntriesSync();
	}

	/**
	 * Synchronous entry read. The SessionStorage contract is async, but
	 * node:sqlite is synchronous, so repo-side helpers (listDetails,
	 * exportToJsonl) that already run off the hot path can read directly.
	 */
	getEntriesSync(): SessionTreeEntry[] {
		const rows = this.db.all<{ data: string }>("SELECT data FROM entries ORDER BY seq");
		return rows.map((row) => deserializeEntry(row, this.location));
	}

	/** Synchronous header read for repo-side detail/export helpers. */
	getHeaderSync(): HeaderRow {
		const header = this.db.get<HeaderRow>(
			"SELECT version, id, timestamp, cwd, parent_session FROM session_header WHERE rowid = 1",
		);
		if (!header) throw invalidSession(this.location, "missing session header");
		return header;
	}
}
