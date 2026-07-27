import {
	type FileError,
	type Result,
	SessionError,
	type SessionMetadata,
	type SessionStorage,
	type SessionTreeEntry,
} from "../types";
import { filterCommittedTransactionEntries, getTransactionForkBoundary } from "./entry-transaction";
import { Session } from "./session";
import { uuidv7 } from "./uuid";

export function createSessionId(): string {
	return uuidv7();
}

export function createTimestamp(): string {
	return new Date().toISOString();
}

export function toSession<TMetadata extends SessionMetadata>(storage: SessionStorage<TMetadata>): Session<TMetadata> {
	return new Session(storage);
}

export function getFileSystemResultOrThrow<TValue>(result: Result<TValue, FileError>, message: string): TValue {
	if (!result.ok) {
		const code = result.error.code === "not_found" ? "not_found" : "storage";
		throw new SessionError(code, `${message}: ${result.error.message}`, result.error);
	}
	return result.value;
}

export async function getEntriesToFork(
	storage: SessionStorage,
	options: { entryId?: string; position?: "before" | "at" },
): Promise<SessionTreeEntry[]> {
	const entries = await storage.getEntries();
	if (!options.entryId) return entries;
	const target = entries.find((entry) => entry.id === options.entryId);
	if (!target) {
		throw new SessionError("invalid_fork_target", `Entry ${options.entryId} not found`);
	}
	const position = options.position ?? "before";
	if (position === "before") {
		if (target.type !== "message" || target.message.role !== "user") {
			throw new SessionError("invalid_fork_target", `Entry ${options.entryId} is not a user message`);
		}
	}
	const effectiveLeafId = getTransactionForkBoundary(entries, target.id, position);
	if (effectiveLeafId == null && position === "at") {
		throw new SessionError("invalid_fork_target", `Entry ${options.entryId} is not a committed session entry`);
	}
	return storage.getPathToRoot(effectiveLeafId);
}

export async function appendCommittedEntryGroups(
	storage: Pick<SessionStorage, "appendEntries">,
	entries: SessionTreeEntry[],
): Promise<void> {
	const committed = filterCommittedTransactionEntries(entries);
	if (committed.entries.length === 0) return;
	await storage.appendEntries(committed.entries);
}
