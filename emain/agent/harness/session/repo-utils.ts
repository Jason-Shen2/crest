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
	storage: Pick<SessionStorage, "appendEntry" | "appendEntries">,
	entries: SessionTreeEntry[],
): Promise<void> {
	const committed = filterCommittedTransactionEntries(entries);
	const appendedTransactions = new Set<string>();
	for (const entry of committed.entries) {
		if (entry.transactionId == null) {
			await storage.appendEntry(entry);
			continue;
		}
		if (appendedTransactions.has(entry.transactionId)) continue;
		const transaction = committed.committedTransactions.get(entry.transactionId);
		if (!transaction) continue;
		await storage.appendEntries(transaction.physicalEntries);
		appendedTransactions.add(entry.transactionId);
	}
}
