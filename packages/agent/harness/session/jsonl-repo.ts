import type {
	FileSystem,
	JsonlSessionCreateOptions,
	JsonlSessionListOptions,
	JsonlSessionMetadata,
	JsonlSessionRepoApi,
	Session,
	SessionDetailInfo,
	SessionDetailListOptions,
} from "../types";
import { SessionError, toError } from "../types";
import { JsonlSessionStorage, loadJsonlSessionMetadata } from "./jsonl-storage";
import {
	createSessionId,
	createTimestamp,
	appendCommittedEntryGroups,
	getEntriesToFork,
	getFileSystemResultOrThrow,
	toSession,
} from "./repo-utils";

type JsonlSessionRepoFileSystem = Pick<
	FileSystem,
	| "cwd"
	| "absolutePath"
	| "joinPath"
	| "readTextFile"
	| "readTextLines"
	| "writeFile"
	| "appendFile"
	| "listDir"
	| "exists"
	| "createDir"
	| "remove"
>;

function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export class JsonlSessionRepo implements JsonlSessionRepoApi {
	private readonly fs: JsonlSessionRepoFileSystem;
	private readonly sessionsRootInput: string;
	private sessionsRoot: string | undefined;

	constructor(options: { fs: JsonlSessionRepoFileSystem; sessionsRoot: string }) {
		this.fs = options.fs;
		this.sessionsRootInput = options.sessionsRoot;
	}

	private async getSessionsRoot(): Promise<string> {
		if (!this.sessionsRoot) {
			this.sessionsRoot = getFileSystemResultOrThrow(
				await this.fs.absolutePath(this.sessionsRootInput),
				`Failed to resolve sessions root ${this.sessionsRootInput}`,
			);
		}
		return this.sessionsRoot;
	}

	private async getSessionDir(cwd: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([await this.getSessionsRoot(), encodeCwd(cwd)]),
			`Failed to resolve session directory for ${cwd}`,
		);
	}

	private async createSessionFilePath(cwd: string, sessionId: string, timestamp: string): Promise<string> {
		return getFileSystemResultOrThrow(
			await this.fs.joinPath([
				await this.getSessionDir(cwd),
				`${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
			]),
			`Failed to resolve session file path for ${sessionId}`,
		);
	}

	async create(options: JsonlSessionCreateOptions): Promise<Session<JsonlSessionMetadata>> {
		const id = options.id ?? createSessionId();
		const createdAt = createTimestamp();
		const sessionDir = await this.getSessionDir(options.cwd);
		getFileSystemResultOrThrow(
			await this.fs.createDir(sessionDir, { recursive: true }),
			`Failed to create session directory ${sessionDir}`,
		);
		const filePath = await this.createSessionFilePath(options.cwd, id, createdAt);
		const storage = await JsonlSessionStorage.create(this.fs, filePath, {
			cwd: options.cwd,
			sessionId: id,
			parentSessionPath: options.parentSessionPath,
		});
		return toSession(storage);
	}

	async open(metadata: JsonlSessionMetadata): Promise<Session<JsonlSessionMetadata>> {
		if (
			!getFileSystemResultOrThrow(await this.fs.exists(metadata.path), `Failed to check session ${metadata.path}`)
		) {
			throw new SessionError("not_found", `Session not found: ${metadata.path}`);
		}
		const storage = await JsonlSessionStorage.open(this.fs, metadata.path);
		return toSession(storage);
	}

	async openPath(filePath: string): Promise<Session<JsonlSessionMetadata>> {
		const metadata = await loadJsonlSessionMetadata(this.fs, filePath);
		return this.open(metadata);
	}

	async list(options: JsonlSessionListOptions = {}): Promise<JsonlSessionMetadata[]> {
		const dirs = options.cwd ? [await this.getSessionDir(options.cwd)] : await this.listSessionDirs();
		const sessions: JsonlSessionMetadata[] = [];
		for (const dir of dirs) {
			if (!getFileSystemResultOrThrow(await this.fs.exists(dir), `Failed to check session directory ${dir}`)) {
				continue;
			}
			const files = getFileSystemResultOrThrow(
				await this.fs.listDir(dir),
				`Failed to list sessions in ${dir}`,
			).filter((file) => file.kind !== "directory" && file.name.endsWith(".jsonl"));
			for (const file of files) {
				try {
					sessions.push(await loadJsonlSessionMetadata(this.fs, file.path));
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
		const dirs = options.cwd ? [await this.getSessionDir(options.cwd)] : await this.listSessionDirs();
		// Collect candidate files (with their cheap fs mtime) across all dirs
		// WITHOUT reading their contents yet. The "all" scope can span many
		// session directories, so we must avoid reading every file from disk.
		const candidates: { path: string; mtimeMs: number }[] = [];
		for (const dir of dirs) {
			if (!getFileSystemResultOrThrow(await this.fs.exists(dir), `Failed to check session directory ${dir}`)) {
				continue;
			}
			const files = getFileSystemResultOrThrow(
				await this.fs.listDir(dir),
				`Failed to list sessions in ${dir}`,
			).filter((file) => file.kind !== "directory" && file.name.endsWith(".jsonl"));
			for (const file of files) {
				candidates.push({ path: file.path, mtimeMs: file.mtimeMs });
			}
		}
		// Pre-sort by fs mtime (a close proxy for last activity) and bound the
		// number of files we actually read+parse to `limit`, so opening the
		// resume panel doesn't scale I/O with the total session count.
		candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
		const toLoad = options.limit ? candidates.slice(0, options.limit) : candidates;
		const sessions: SessionDetailInfo[] = [];
		for (const candidate of toLoad) {
			try {
				const detail = await this.loadSessionDetail(candidate.path);
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

	private async loadSessionDetail(filePath: string): Promise<SessionDetailInfo | null> {
		const storage = await JsonlSessionStorage.open(this.fs, filePath);
		const header = await storage.getMetadata();
		const entries = await storage.getEntries();
		let name: string | undefined;
		let messageCount = 0;
		let firstMessage = "";
		let previewParts: string[] = [];
		let lastActivityTime: string | null = null;
		const PREVIEW_MAX_LENGTH = 200;
		const PREVIEW_MAX_MESSAGES = 6;

		for (const entry of entries) {
			lastActivityTime = entry.timestamp;

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
				const snippet = prefix + text.slice(0, 80);
				previewParts.push(snippet);
			}
		}

		const previewText = previewParts.join("  ").slice(0, PREVIEW_MAX_LENGTH);
		const modifiedAt = lastActivityTime ?? header.createdAt;

		return {
			id: header.id,
			path: filePath,
			cwd: header.cwd,
			parentSessionPath: header.parentSessionPath,
			createdAt: header.createdAt,
			modifiedAt,
			name,
			messageCount,
			firstMessage,
			previewText,
		};
	}

	async delete(metadata: JsonlSessionMetadata): Promise<void> {
		getFileSystemResultOrThrow(
			await this.fs.remove(metadata.path, { force: true }),
			`Failed to delete session ${metadata.path}`,
		);
	}

	async fork(
		sourceMetadata: JsonlSessionMetadata,
		options: JsonlSessionCreateOptions & { entryId?: string; position?: "before" | "at"; id?: string },
	): Promise<Session<JsonlSessionMetadata>> {
		const source = await this.open(sourceMetadata);
		const forkedEntries = await getEntriesToFork(source.getStorage(), options);
		const id = options.id ?? createSessionId();
		const createdAt = createTimestamp();
		const sessionDir = await this.getSessionDir(options.cwd);
		getFileSystemResultOrThrow(
			await this.fs.createDir(sessionDir, { recursive: true }),
			`Failed to create session directory ${sessionDir}`,
		);
		const storage = await JsonlSessionStorage.create(
			this.fs,
			await this.createSessionFilePath(options.cwd, id, createdAt),
			{
				cwd: options.cwd,
				sessionId: id,
				parentSessionPath: options.parentSessionPath ?? sourceMetadata.path,
			},
		);
		await appendCommittedEntryGroups(storage, forkedEntries);
		return toSession(storage);
	}

	private async listSessionDirs(): Promise<string[]> {
		const sessionsRoot = await this.getSessionsRoot();
		if (
			!getFileSystemResultOrThrow(
				await this.fs.exists(sessionsRoot),
				`Failed to check sessions root ${sessionsRoot}`,
			)
		) {
			return [];
		}
		const entries = getFileSystemResultOrThrow(
			await this.fs.listDir(sessionsRoot),
			`Failed to list sessions root ${sessionsRoot}`,
		);
		return entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path);
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
