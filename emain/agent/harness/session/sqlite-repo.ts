// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// sqlite-repo.ts — a SessionRepo over SqliteSessionStorage. Drop-in
// replacement for JsonlSessionRepo: same JsonlSessionRepoApi surface
// (create / open / openPath / list / listDetails / delete / fork) and the
// same on-disk layout ({sessionsRoot}/{encodedCwd}/{timestamp}_{id}.db),
// only the per-session carrier is a SQLite .db instead of a .jsonl file.
//
// Because node:sqlite needs a real filesystem path, this repo talks to
// node:fs / node:path directly rather than the harness FileSystem
// abstraction (which JsonlSessionRepo uses). The session-tree semantics are
// unchanged — they live in SqliteSessionStorage / Session.
//
// JSONL stays available as an *interchange format* (not the carrier):
// exportToJsonl serializes a .db back to byte-compatible JSONL, and
// importFromJsonl parses a JSONL file (reusing jsonl-storage's
// parseHeaderLine / parseEntryLine) and replays it into a fresh .db. See
// docs/agent-dual-mode-design.html §9.1.

import { promises as fsp } from "node:fs";
import * as path from "node:path";

import type {
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionRepoApi,
	Session,
	SessionDetailInfo,
	SessionDetailListOptions,
	SessionTreeEntry,
} from "../types";
import { SessionError, toError } from "../types";
import { NodeExecutionEnv } from "../../node";
import { JsonlSessionStorage } from "./jsonl-storage";
import { appendCommittedEntryGroups, createSessionId, createTimestamp, getEntriesToFork, toSession } from "./repo-utils";
import { SqliteSessionStorage } from "./sqlite-storage";

const SESSION_FILE_EXT = ".db";

function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fsp.access(target);
		return true;
	} catch {
		return false;
	}
}

function extractMessageText(msg: Record<string, unknown>): string {
	const content = msg.content;
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter((b): b is { type: string; text: string } => b && typeof b === "object" && b.type === "text")
			.map((b) => b.text)
			.join(" ")
			.trim();
	}
	return "";
}

export class SqliteSessionRepo implements JsonlSessionRepoApi {
	private readonly sessionsRoot: string;

	constructor(options: { sessionsRoot: string }) {
		this.sessionsRoot = path.resolve(options.sessionsRoot);
	}

	private getSessionDir(cwd: string): string {
		return path.join(this.sessionsRoot, encodeCwd(cwd));
	}

	private createSessionFilePath(cwd: string, sessionId: string, timestamp: string): string {
		return path.join(this.getSessionDir(cwd), `${timestamp.replace(/[:.]/g, "-")}_${sessionId}${SESSION_FILE_EXT}`);
	}

	async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		const id = options.id ?? createSessionId();
		const createdAt = createTimestamp();
		const sessionDir = this.getSessionDir(options.cwd);
		await fsp.mkdir(sessionDir, { recursive: true });
		const filePath = this.createSessionFilePath(options.cwd, id, createdAt);
		const storage = SqliteSessionStorage.create(filePath, {
			cwd: options.cwd,
			sessionId: id,
			parentSessionPath: options.parentSessionPath,
		});
		return toSession(storage);
	}

	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		if (!(await pathExists(metadata.path))) {
			throw new SessionError("not_found", `Session not found: ${metadata.path}`);
		}
		return toSession(SqliteSessionStorage.open(metadata.path));
	}

	async openPath(filePath: string): Promise<Session<JsonlSessionMetadata>> {
		if (!(await pathExists(filePath))) {
			throw new SessionError("not_found", `Session not found: ${filePath}`);
		}
		return toSession(SqliteSessionStorage.open(filePath));
	}

	async list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		const dirs = options.cwd ? [this.getSessionDir(options.cwd)] : await this.listSessionDirs();
		const sessions: JsonlSessionMetadata[] = [];
		for (const dir of dirs) {
			for (const filePath of await this.listSessionFiles(dir)) {
				try {
					const storage = SqliteSessionStorage.open(filePath);
					try {
						sessions.push(await storage.getMetadata());
					} finally {
						storage.close();
					}
				} catch (error) {
					const cause = toError(error);
					if (!(cause instanceof SessionError) || cause.code !== "invalid_session") throw cause;
				}
			}
		}
		sessions.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
		return sessions;
	}

	async listDetails(options: SessionDetailListOptions = {}): Promise<SessionDetailInfo[]> {
		const dirs = options.cwd ? [this.getSessionDir(options.cwd)] : await this.listSessionDirs();
		// Collect candidate files with their cheap fs mtime, WITHOUT opening
		// each .db yet — the "all" scope can span many directories.
		const candidates: { path: string; mtimeMs: number }[] = [];
		for (const dir of dirs) {
			for (const filePath of await this.listSessionFiles(dir)) {
				try {
					const stat = await fsp.stat(filePath);
					candidates.push({ path: filePath, mtimeMs: stat.mtimeMs });
				} catch {
					// File vanished between listing and stat; skip it.
				}
			}
		}
		// Pre-sort by fs mtime (a close proxy for last activity) and bound the
		// number of files we actually open+query to `limit`.
		candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
		const toLoad = options.limit ? candidates.slice(0, options.limit) : candidates;
		const sessions: SessionDetailInfo[] = [];
		for (const candidate of toLoad) {
			try {
				const detail = this.loadSessionDetail(candidate.path);
				if (detail) sessions.push(detail);
			} catch (error) {
				const cause = toError(error);
				if (!(cause instanceof SessionError) || cause.code !== "invalid_session") throw cause;
			}
		}
		// Re-sort by the content-accurate modifiedAt now that details are loaded.
		sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
		return sessions;
	}

	private loadSessionDetail(filePath: string): SessionDetailInfo | null {
		const storage = SqliteSessionStorage.open(filePath);
		try {
			const header = storage.getHeaderSync();
			const entries = storage.getEntriesSync();

			const PREVIEW_MAX_LENGTH = 200;
			const PREVIEW_MAX_MESSAGES = 6;
			let name: string | undefined;
			let messageCount = 0;
			let firstMessage = "";
			const previewParts: string[] = [];
			let lastActivityTime: string | null = null;

			for (const entry of entries) {
				if (typeof entry.timestamp === "string") lastActivityTime = entry.timestamp;

				if (entry.type === "session_info" && typeof entry.name === "string") {
					const trimmed = entry.name.trim();
					if (trimmed) name = trimmed;
				}

				if (entry.type !== "message") continue;
				messageCount++;

				const msg = entry.message as unknown as Record<string, unknown> | undefined;
				if (!msg) continue;
				const role = typeof msg.role === "string" ? msg.role : null;
				if (role !== "user" && role !== "assistant") continue;

				const text = extractMessageText(msg);
				if (!text) continue;

				if (!firstMessage && role === "user") {
					firstMessage = text.slice(0, 120);
				}
				if (previewParts.length < PREVIEW_MAX_MESSAGES) {
					const prefix = role === "user" ? "" : "‖ ";
					previewParts.push(prefix + text.slice(0, 80));
				}
			}

			const previewText = previewParts.join("  ").slice(0, PREVIEW_MAX_LENGTH);
			const modifiedAt = lastActivityTime ?? header.timestamp;

			return {
				id: header.id,
				path: filePath,
				cwd: header.cwd,
				parentSessionPath: header.parent_session ?? undefined,
				createdAt: header.timestamp,
				modifiedAt,
				name,
				messageCount,
				firstMessage,
				previewText,
			};
		} finally {
			storage.close();
		}
	}

	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		await fsp.rm(metadata.path, { force: true });
	}

	async fork(
		sourceMetadata: JsonlSessionMetadata,
		options: JsonlSessionCreateOptions & { entryId?: string; position?: "before" | "at"; id?: string },
	): Promise<Session<JsonlSessionMetadata>> {
		const source = await this.open(sourceMetadata);
		const forkedEntries = await getEntriesToFork(source.getStorage(), options);
		const id = options.id ?? createSessionId();
		const createdAt = createTimestamp();
		const sessionDir = this.getSessionDir(options.cwd);
		await fsp.mkdir(sessionDir, { recursive: true });
		const storage = SqliteSessionStorage.create(this.createSessionFilePath(options.cwd, id, createdAt), {
			cwd: options.cwd,
			sessionId: id,
			parentSessionPath: options.parentSessionPath ?? sourceMetadata.path,
		});
		await appendCommittedEntryGroups(storage, forkedEntries);
		return toSession(storage);
	}

	/**
	 * Export a session .db to a byte-compatible JSONL string: the session
	 * header on line 1, then one JSON.stringify(entry) per line, in insertion
	 * order. The output is identical to what JsonlSessionStorage would have
	 * written, so it round-trips through any JSONL consumer (upstream pi, etc.).
	 */
	async exportToJsonl(metadata: JsonlSessionMetadata): Promise<string> {
		const storage = SqliteSessionStorage.open(metadata.path);
		try {
			const header = storage.getHeaderSync();
			const lines: string[] = [
				JSON.stringify({
					type: "session",
					version: header.version,
					id: header.id,
					timestamp: header.timestamp,
					cwd: header.cwd,
					...(header.parent_session ? { parentSession: header.parent_session } : {}),
				}),
			];
			for (const entry of storage.getEntriesSync()) {
				lines.push(JSON.stringify(entry));
			}
			return lines.join("\n") + "\n";
		} finally {
			storage.close();
		}
	}

	/**
	 * Import a JSONL file into a fresh session .db. Unlike the old
	 * file-copy "import", this is a real parse + replay: every line is
	 * validated via jsonl-storage's parsers and appended into SQLite, so a
	 * malformed or wrong-version file is rejected instead of silently stored.
	 */
	async importFromJsonl(jsonlPath: string, options: { cwd: string; id?: string }): Promise<Session<JsonlSessionMetadata>> {
		const inputPath = path.resolve(jsonlPath);
		const env = new NodeExecutionEnv({ cwd: path.dirname(inputPath) });
		let sourceMetadata: JsonlSessionMetadata;
		let entries: SessionTreeEntry[];
		try {
			const source = await JsonlSessionStorage.open(env, inputPath);
			[sourceMetadata, entries] = await Promise.all([source.getMetadata(), source.getEntries()]);
		} finally {
			await env.cleanup();
		}

		const id = options.id ?? sourceMetadata.id ?? createSessionId();
		const createdAt = createTimestamp();
		const sessionDir = this.getSessionDir(options.cwd);
		await fsp.mkdir(sessionDir, { recursive: true });
		const storage = SqliteSessionStorage.create(this.createSessionFilePath(options.cwd, id, createdAt), {
			cwd: options.cwd,
			sessionId: id,
			parentSessionPath: sourceMetadata.parentSessionPath,
		});
		await appendCommittedEntryGroups(storage, entries);
		return toSession(storage);
	}

	private async listSessionDirs(): Promise<string[]> {
		if (!(await pathExists(this.sessionsRoot))) return [];
		const dirents = await fsp.readdir(this.sessionsRoot, { withFileTypes: true });
		return dirents.filter((d) => d.isDirectory()).map((d) => path.join(this.sessionsRoot, d.name));
	}

	private async listSessionFiles(dir: string): Promise<string[]> {
		if (!(await pathExists(dir))) return [];
		const dirents = await fsp.readdir(dir, { withFileTypes: true });
		return dirents
			.filter((d) => !d.isDirectory() && d.name.endsWith(SESSION_FILE_EXT))
			.map((d) => path.join(dir, d.name));
	}
}
