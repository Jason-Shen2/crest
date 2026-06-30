// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// sqlite-driver.ts — a thin wrapper around Node's built-in `node:sqlite`
// (DatabaseSync). It exists to isolate the *experimental* standard-library
// API behind a tiny, stable surface so the rest of the session storage layer
// never imports `node:sqlite` directly. If the API shifts (it is marked
// experimental as of Node 22) or we ever swap the backend (e.g. better-sqlite3),
// only this file changes.
//
// Why node:sqlite and not better-sqlite3: crest ships on Electron ^41 whose
// embedded Node is >= 22, which bundles `node:sqlite`. Using it means zero
// native dependencies and no electron-rebuild / ABI headaches. See
// docs/agent-dual-mode-design.html §9.2 (the A′ route).

import { DatabaseSync } from "node:sqlite";

/** A single bound value accepted by the underlying statement. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/** A row returned from a query, keyed by column name. */
export type SqlRow = Record<string, SqlValue>;

/** Result of a non-SELECT statement execution. */
export interface SqlRunResult {
	changes: number | bigint;
	lastInsertRowid: number | bigint;
}

/**
 * Minimal synchronous SQLite handle. Synchronous is fine here: session files
 * are small, single-writer (one repo per process), and the call sites are
 * already `async` so they never block the event loop in any meaningful way.
 */
export class SqliteDb {
	private readonly db: DatabaseSync;

	constructor(location: string) {
		this.db = new DatabaseSync(location);
	}

	/** Run one or more semicolon-separated statements with no parameters. */
	exec(sql: string): void {
		this.db.exec(sql);
	}

	/** Execute a parameterized non-SELECT statement (INSERT/UPDATE/DELETE/DDL). */
	run(sql: string, ...params: SqlValue[]): SqlRunResult {
		const stmt = this.db.prepare(sql);
		return stmt.run(...params) as SqlRunResult;
	}

	/** Return the first matching row, or `undefined` when there are none. */
	get<TRow = SqlRow>(sql: string, ...params: SqlValue[]): TRow | undefined {
		const stmt = this.db.prepare(sql);
		return stmt.get(...params) as TRow | undefined;
	}

	/** Return every matching row in result order. */
	all<TRow = SqlRow>(sql: string, ...params: SqlValue[]): TRow[] {
		const stmt = this.db.prepare(sql);
		return stmt.all(...params) as TRow[];
	}

	/** Close the handle. Best-effort; safe to call once. */
	close(): void {
		this.db.close();
	}
}
