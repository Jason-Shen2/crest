// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
//
// Tests for SqliteSessionStorage / SqliteSessionRepo and the JSONL
// import/export interchange path. Mirrors the JSONL repo test coverage in
// sessions.test.ts so the SQLite carrier is a verified drop-in.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JsonlSessionRepo } from "./jsonl-repo";
import { makeCommittedContextTransaction } from "./context-transaction-fixture";
import { foldContextJournal } from "../../context/journal";
import { SqliteSessionRepo } from "./sqlite-repo";
import { SqliteSessionStorage } from "./sqlite-storage";
import { SqliteDb } from "./sqlite-driver";
import type { AgentMessage } from "../../types";
import type { JsonlSessionMetadata, SessionTreeEntry } from "../types";
import { NodeExecutionEnv } from "../../node";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function assistant(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function messageEntry(id: string, parentId: string | null): Extract<SessionTreeEntry, { type: "message" }> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: user(id),
	};
}

function sqliteDb(storage: SqliteSessionStorage): SqliteDb {
	return (storage as unknown as { db: SqliteDb }).db;
}

function historyReadCalls(calls: unknown[][]): unknown[][] {
	return calls.filter(([sql]) => /SELECT\b.*\bdata\b.*\bFROM entries\b/i.test(String(sql)));
}

describe("SqliteSessionStorage", () => {
	let tmpRoot: string;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crest-sqlite-storage-"));
	});

	afterEach(async () => {
		await fs.rm(tmpRoot, { recursive: true, force: true });
	});

	function dbPath(name = "s.db"): string {
		return path.join(tmpRoot, name);
	}

	it("create writes a header readable as metadata", async () => {
		const storage = SqliteSessionStorage.create(dbPath(), { cwd: "/tmp/proj", sessionId: "abc123" });
		const meta = await storage.getMetadata();
		expect(meta.id).toBe("abc123");
		expect(meta.cwd).toBe("/tmp/proj");
		expect(meta.path).toBe(dbPath());
		expect(meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		storage.close();
	});

	it("appendEntry + getEntry round-trips a message entry", async () => {
		const storage = SqliteSessionStorage.create(dbPath(), { cwd: "/c", sessionId: "s1" });
		const id = await storage.createEntryId();
		await storage.appendEntry({
			type: "message",
			id,
			parentId: null,
			timestamp: new Date().toISOString(),
			message: user("hello"),
		});
		const got = await storage.getEntry(id);
		expect(got?.type).toBe("message");
		expect((got as { message: { content: { text: string }[] } }).message.content[0].text).toBe("hello");
		storage.close();
	});

	it("does not reread historical entry payloads when the append index cache is current", async () => {
		const storage = SqliteSessionStorage.create(dbPath(), { cwd: "/c", sessionId: "s1" });
		await storage.appendEntry(messageEntry("root", null));
		const all = vi.spyOn(sqliteDb(storage), "all");

		await storage.appendEntry(messageEntry("child", "root"));

		expect(historyReadCalls(all.mock.calls)).toEqual([]);
		storage.close();
	});

	it("uses the database leaf for CAS across two handles without writing a stale append", async () => {
		const location = dbPath();
		const first = SqliteSessionStorage.create(location, { cwd: "/c", sessionId: "s1" });
		await first.appendEntry({
			type: "message",
			id: "root",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: user("root"),
		});
		const second = SqliteSessionStorage.open(location);
		try {
			await second.appendEntry({
				type: "message",
				id: "ordinary",
				parentId: "root",
				timestamp: new Date().toISOString(),
				message: user("ordinary"),
			});

			await expect(
				first.appendEntries(
					[
						{
							type: "message",
							id: "stale",
							parentId: "root",
							timestamp: new Date().toISOString(),
							message: user("stale"),
						},
					],
					{ expectedLeafId: "root" },
				),
			).rejects.toMatchObject({ code: "stale_leaf" });
			expect((await first.getEntries()).map((entry) => entry.id)).toEqual(["root", "ordinary"]);
		} finally {
			second.close();
			first.close();
		}
	});

	it("validates and refreshes append indexes from authoritative database state", async () => {
		const location = dbPath();
		const first = SqliteSessionStorage.create(location, { cwd: "/c", sessionId: "s1" });
		await first.appendEntry({
			type: "message",
			id: "root",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: user("root"),
		});
		const second = SqliteSessionStorage.open(location);
		try {
			await second.appendEntry({
				type: "message",
				id: "ordinary",
				parentId: "root",
				timestamp: new Date().toISOString(),
				message: user("ordinary"),
			});
			const all = vi.spyOn(sqliteDb(first), "all");
			await first.appendEntries(
				[
					{
						type: "message",
						id: "current",
						parentId: "ordinary",
						timestamp: new Date().toISOString(),
						message: user("current"),
					},
				],
				{ expectedLeafId: "ordinary" },
			);
			const incrementalReads = historyReadCalls(all.mock.calls);
			expect(incrementalReads).toHaveLength(1);
			expect(incrementalReads[0]![0]).toMatch(/WHERE seq > \?/i);
			expect(incrementalReads[0]![1]).toBe(1);
			all.mockClear();
			await first.appendEntries([messageEntry("after-refresh", "current")], {
				expectedLeafId: "current",
			});

			expect(historyReadCalls(all.mock.calls)).toEqual([]);
			expect((await first.getEntries()).map((entry) => entry.id)).toEqual([
				"root",
				"ordinary",
				"current",
				"after-refresh",
			]);
			expect(await first.getLeafId()).toBe("after-refresh");
		} finally {
			second.close();
			first.close();
		}
	});

	it("appendEntries rolls back the first insert when a later ID is duplicated", async () => {
		const storage = SqliteSessionStorage.create(dbPath(), { cwd: "/c", sessionId: "s1" });
		const original = await storage.createEntryId();
		await storage.appendEntry({ type: "message", id: original, parentId: null, timestamp: new Date().toISOString(), message: user("original") });

		await expect(
			storage.appendEntries([
				{ type: "message", id: "first", parentId: original, timestamp: new Date().toISOString(), message: user("first") },
				{ type: "message", id: original, parentId: "first", timestamp: new Date().toISOString(), message: user("duplicate") },
			]),
		).rejects.toThrow(/duplicate/i);

		expect((await storage.getEntries()).map((entry) => entry.id)).toEqual([original]);
		expect(await storage.getLeafId()).toBe(original);
		storage.close();
	});

	it("appendEntries rejects an incomplete transaction before changing SQLite", async () => {
		const storage = SqliteSessionStorage.create(dbPath(), { cwd: "/c", sessionId: "s1" });
		await expect(
			storage.appendEntries([
				{
					type: "custom",
					id: "orphan",
					parentId: null,
					timestamp: new Date().toISOString(),
					customType: "context_artifact",
					data: {},
					transactionId: "tx",
				},
			]),
		).rejects.toThrow(/transaction|manifest/i);
		expect(await storage.getEntries()).toEqual([]);
		storage.close();
	});

	it("appendEntries rolls back inserts when a later entry cannot be serialized", async () => {
		const storage = SqliteSessionStorage.create(dbPath(), { cwd: "/c", sessionId: "s1" });
		await expect(
			storage.appendEntries([
				{ type: "message", id: "first", parentId: null, timestamp: new Date().toISOString(), message: user("first") },
				{
					type: "message",
					id: "second",
					parentId: "first",
					timestamp: new Date().toISOString(),
					message: { role: "user", content: [{ type: "text", text: BigInt(1) }] } as unknown as AgentMessage,
				},
			]),
		).rejects.toThrow(/BigInt/i);
		expect(await storage.getEntries()).toEqual([]);
		expect(await storage.getLeafId()).toBeNull();
		storage.close();
	});

	it("keeps the published append cache clean after rollback", async () => {
		const storage = SqliteSessionStorage.create(dbPath(), { cwd: "/c", sessionId: "s1" });
		await storage.appendEntry(messageEntry("root", null));
		const all = vi.spyOn(sqliteDb(storage), "all");
		await expect(
			storage.appendEntries([
				messageEntry("rolled-back-first", "root"),
				{
					...messageEntry("rolled-back-second", "rolled-back-first"),
					message: {
						role: "user",
						content: [{ type: "text", text: BigInt(1) }],
					} as unknown as AgentMessage,
				},
			]),
		).rejects.toThrow(/BigInt/i);
		all.mockClear();

		await storage.appendEntry(messageEntry("rolled-back-first", "root"));

		expect(historyReadCalls(all.mock.calls)).toEqual([]);
		expect((await storage.getEntries()).map((entry) => entry.id)).toEqual(["root", "rolled-back-first"]);
		storage.close();
	});

	it("detects an entry ID appended through another handle", async () => {
		const location = dbPath();
		const first = SqliteSessionStorage.create(location, { cwd: "/c", sessionId: "s1" });
		await first.appendEntry(messageEntry("root", null));
		const second = SqliteSessionStorage.open(location);
		try {
			await second.appendEntry(messageEntry("external", "root"));

			await expect(
				first.appendEntries([messageEntry("external", "external")], {
					expectedLeafId: "external",
				}),
			).rejects.toThrow(/duplicate session entry ID external/i);
			expect((await first.getEntries()).map((entry) => entry.id)).toEqual(["root", "external"]);
		} finally {
			second.close();
			first.close();
		}
	});

	it("detects a transaction ID appended through another handle", async () => {
		const location = dbPath();
		const first = SqliteSessionStorage.create(location, { cwd: "/c", sessionId: "s1" });
		await first.appendEntry(messageEntry("root", null));
		const second = SqliteSessionStorage.open(location);
		try {
			const external = makeCommittedContextTransaction({ parentId: "root", prefix: "external" });
			await second.appendEntries(external);

			await expect(
				first.appendEntries(
					[
						{
							type: "custom",
							id: "duplicate-transaction",
							parentId: external.at(-1)!.id,
							timestamp: new Date().toISOString(),
							customType: "record",
							data: {},
							transactionId: "external-transaction",
						},
					],
					{ expectedLeafId: external.at(-1)!.id },
				),
			).rejects.toThrow(/duplicate session transaction ID external-transaction/i);
			expect((await first.getEntries()).map((entry) => entry.id)).toEqual([
				"root",
				...external.map((entry) => entry.id),
			]);
		} finally {
			second.close();
			first.close();
		}
	});

	it("SqliteDb rolls back a failed multi-insert transaction", () => {
		const db = new SqliteDb(dbPath("transaction.db"));
		db.exec("CREATE TABLE values_table (id TEXT PRIMARY KEY)");

		expect(() => db.transaction(() => {
			db.run("INSERT INTO values_table (id) VALUES (?)", "first");
			db.run("INSERT INTO values_table (id) VALUES (?)", "first");
		})).toThrow(/UNIQUE/i);

		expect(db.all("SELECT id FROM values_table")).toEqual([]);
		db.close();
	});

	it("getLeafId tracks the last appended entry and setLeafId records a leaf", async () => {
		const storage = SqliteSessionStorage.create(dbPath(), { cwd: "/c", sessionId: "s1" });
		expect(await storage.getLeafId()).toBeNull();

		const a = await storage.createEntryId();
		await storage.appendEntry({ type: "message", id: a, parentId: null, timestamp: new Date().toISOString(), message: user("a") });
		expect(await storage.getLeafId()).toBe(a);

		const b = await storage.createEntryId();
		await storage.appendEntry({ type: "message", id: b, parentId: a, timestamp: new Date().toISOString(), message: assistant("b") });
		expect(await storage.getLeafId()).toBe(b);

		// Move the leaf back to `a` via a leaf entry.
		await storage.setLeafId(a);
		expect(await storage.getLeafId()).toBe(a);
		storage.close();
	});

	it("getPathToRoot walks the parentId chain", async () => {
		const storage = SqliteSessionStorage.create(dbPath(), { cwd: "/c", sessionId: "s1" });
		const a = await storage.createEntryId();
		await storage.appendEntry({ type: "message", id: a, parentId: null, timestamp: new Date().toISOString(), message: user("a") });
		const b = await storage.createEntryId();
		await storage.appendEntry({ type: "message", id: b, parentId: a, timestamp: new Date().toISOString(), message: assistant("b") });

		const path0 = await storage.getPathToRoot(b);
		expect(path0.map((e) => e.id)).toEqual([a, b]);
		expect(await storage.getPathToRoot(null)).toEqual([]);
		storage.close();
	});

	it("findEntries filters by type and getLabel returns the latest label", async () => {
		const storage = SqliteSessionStorage.create(dbPath(), { cwd: "/c", sessionId: "s1" });
		const a = await storage.createEntryId();
		await storage.appendEntry({ type: "message", id: a, parentId: null, timestamp: new Date().toISOString(), message: user("a") });
		const l1 = await storage.createEntryId();
		await storage.appendEntry({ type: "label", id: l1, parentId: a, timestamp: new Date().toISOString(), targetId: a, label: "first" });
		const l2 = await storage.createEntryId();
		await storage.appendEntry({ type: "label", id: l2, parentId: l1, timestamp: new Date().toISOString(), targetId: a, label: "second" });

		const labels = await storage.findEntries("label");
		expect(labels).toHaveLength(2);
		expect(await storage.getLabel(a)).toBe("second");
		storage.close();
	});

	it("reopen sees previously persisted entries", async () => {
		const created = SqliteSessionStorage.create(dbPath(), { cwd: "/c", sessionId: "s1" });
		const a = await created.createEntryId();
		await created.appendEntry({ type: "message", id: a, parentId: null, timestamp: new Date().toISOString(), message: user("persisted") });
		created.close();

		const reopened = SqliteSessionStorage.open(dbPath());
		const entries = await reopened.getEntries();
		expect(entries).toHaveLength(1);
		expect(entries[0].id).toBe(a);
		reopened.close();
	});

	it("open rejects a database with no session header", async () => {
		// node:sqlite auto-creates an empty .db at an unknown path; opening it
		// as a session must surface as invalid_session (no header row).
		expect(() => SqliteSessionStorage.open(path.join(tmpRoot, "fresh.db"))).toThrow(/missing session header/);
	});

	it("open reads metadata without deserializing malformed entry payloads", async () => {
		const created = SqliteSessionStorage.create(dbPath(), { cwd: "/c", sessionId: "s1" });
		created.close();
		const db = new SqliteDb(dbPath());
		db.run(
			"INSERT INTO entries (id, parent_id, type, timestamp, target_id, data) VALUES (?, ?, ?, ?, ?, ?)",
			"broken",
			null,
			"message",
			new Date().toISOString(),
			null,
			"not-json",
		);
		db.close();

		const reopened = SqliteSessionStorage.open(dbPath());
		expect((await reopened.getMetadata()).id).toBe("s1");
		await expect(reopened.getEntries()).rejects.toThrow(/valid JSON/i);
		reopened.close();
	});
});

describe("SqliteSessionRepo — drop-in for JsonlSessionRepo", () => {
	let tmpRoot: string;
	let repo: SqliteSessionRepo;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crest-sqlite-repo-"));
		repo = new SqliteSessionRepo({ sessionsRoot: tmpRoot });
	});

	afterEach(async () => {
		await fs.rm(tmpRoot, { recursive: true, force: true });
	});

	it("create mints metadata with all four required fields and a .db path", async () => {
		const session = await repo.create({ cwd: "/tmp/some-project" });
		const metadata = await session.getMetadata();
		expect(metadata.id).toMatch(/^[0-9a-f-]{20,}$/i);
		expect(metadata.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(metadata.cwd).toBe("/tmp/some-project");
		expect(metadata.path).toContain(tmpRoot);
		expect(metadata.path.endsWith(".db")).toBe(true);
	});

	it("open returns a Session with matching metadata", async () => {
		const created = await repo.create({ cwd: "/tmp/proj-b" });
		const createdMeta = await created.getMetadata();
		const reopened = await repo.open(createdMeta);
		const reopenedMeta = await reopened.getMetadata();
		expect(reopenedMeta.id).toBe(createdMeta.id);
		expect(reopenedMeta.path).toBe(createdMeta.path);
		expect(reopenedMeta.cwd).toBe("/tmp/proj-b");
	});

	it("openPath reopens a session when only the db path is known", async () => {
		const created = await repo.create({ cwd: "/tmp/proj-path-only" });
		await created.appendMessage(user("persisted q"));
		const createdMeta = await created.getMetadata();

		const reopened = await repo.openPath(createdMeta.path);
		const context = await reopened.buildContext();
		expect(context.messages).toHaveLength(1);
		expect((context.messages[0] as { content: { text: string }[] }).content[0].text).toBe("persisted q");
	});

	it("open throws not_found for a missing session", async () => {
		const meta: JsonlSessionMetadata = {
			id: "x",
			createdAt: new Date().toISOString(),
			cwd: "/tmp/none",
			path: path.join(tmpRoot, "nope.db"),
		};
		await expect(repo.open(meta)).rejects.toThrow(/not found/i);
	});

	it("fork before a user message records the source path", async () => {
		const source = await repo.create({ cwd: "/tmp/proj-fork" });
		await source.appendMessage(user("keep this"));
		const forkPointId = await source.appendMessage(user("fork from here"));
		const sourceMeta = await source.getMetadata();

		const forked = await repo.fork(sourceMeta, { cwd: "/tmp/proj-fork", entryId: forkPointId });
		const forkedMeta = await forked.getMetadata();
		const context = await forked.buildContext();

		expect(forkedMeta.cwd).toBe("/tmp/proj-fork");
		expect(forkedMeta.parentSessionPath).toBe(sourceMeta.path);
		expect(context.messages).toHaveLength(1);
		expect((context.messages[0] as { content: { text: string }[] }).content[0].text).toBe("keep this");
	});

	it("list returns only sessions for the given cwd, newest first", async () => {
		const a1 = await (await repo.create({ cwd: "/tmp/proj-x" })).getMetadata();
		await new Promise((r) => setTimeout(r, 10));
		const a2 = await (await repo.create({ cwd: "/tmp/proj-x" })).getMetadata();
		await new Promise((r) => setTimeout(r, 10));
		await repo.create({ cwd: "/tmp/proj-y" });

		const list = await repo.list({ cwd: "/tmp/proj-x" });
		expect(list).toHaveLength(2);
		expect(list[0].id).toBe(a2.id);
		expect(list[1].id).toBe(a1.id);
	});

	it("list returns [] for a cwd with no sessions", async () => {
		await repo.create({ cwd: "/tmp/proj-other" });
		expect(await repo.list({ cwd: "/tmp/never-touched" })).toEqual([]);
	});

	it("delete removes the session file", async () => {
		const created = await repo.create({ cwd: "/tmp/proj-del" });
		const meta = await created.getMetadata();
		await repo.delete(meta);
		await expect(fs.access(meta.path)).rejects.toThrow();
	});

	it("listDetails derives messageCount, firstMessage and previewText", async () => {
		const created = await repo.create({ cwd: "/tmp/proj-details" });
		await created.appendMessage(user("hello there"));
		await created.appendMessage(assistant("general kenobi"));
		const meta = await created.getMetadata();

		const details = await repo.listDetails({ cwd: "/tmp/proj-details" });
		expect(details).toHaveLength(1);
		expect(details[0].id).toBe(meta.id);
		expect(details[0].messageCount).toBe(2);
		expect(details[0].firstMessage).toBe("hello there");
		expect(details[0].previewText).toContain("hello there");
		expect(details[0].previewText).toContain("general kenobi");
	});

	it("listDetails bounds the result set with limit, newest first across all cwds", async () => {
		await repo.create({ cwd: "/tmp/proj-lim-a" });
		await new Promise((r) => setTimeout(r, 10));
		await repo.create({ cwd: "/tmp/proj-lim-b" });
		await new Promise((r) => setTimeout(r, 10));
		const newest = await (await repo.create({ cwd: "/tmp/proj-lim-c" })).getMetadata();

		const details = await repo.listDetails({ limit: 2 });
		expect(details).toHaveLength(2);
		expect(details[0].id).toBe(newest.id);
	});
});

describe("SqliteSessionRepo — JSONL interchange", () => {
	let tmpRoot: string;
	let jsonlRoot: string;
	let repo: SqliteSessionRepo;
	let jsonlRepo: JsonlSessionRepo;

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crest-sqlite-xchg-"));
		jsonlRoot = await fs.mkdtemp(path.join(os.tmpdir(), "crest-jsonl-xchg-"));
		repo = new SqliteSessionRepo({ sessionsRoot: tmpRoot });
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		jsonlRepo = new JsonlSessionRepo({ fs: env, sessionsRoot: jsonlRoot });
	});

	afterEach(async () => {
		await fs.rm(tmpRoot, { recursive: true, force: true });
		await fs.rm(jsonlRoot, { recursive: true, force: true });
	});

	it("exportToJsonl produces a header line + one JSON entry per line", async () => {
		const created = await repo.create({ cwd: "/tmp/exp" });
		await created.appendMessage(user("q1"));
		await created.appendMessage(assistant("a1"));
		const meta = await created.getMetadata();

		const jsonl = await repo.exportToJsonl(meta);
		const lines = jsonl.split("\n").filter((l) => l.trim());
		const header = JSON.parse(lines[0]);
		expect(header.type).toBe("session");
		expect(header.version).toBe(3);
		expect(header.id).toBe(meta.id);
		expect(header.cwd).toBe("/tmp/exp");
		// header + 2 messages (no leaf entry was appended via setLeafId)
		expect(lines.length).toBe(3);
		expect(JSON.parse(lines[1]).type).toBe("message");
	});

	it("importFromJsonl parses + replays a JSONL file into a fresh .db", async () => {
		// Build a real JSONL session with the JSONL repo, then import it.
		const src = await jsonlRepo.create({ cwd: "/tmp/imp" });
		await src.appendMessage(user("imported question"));
		await src.appendMessage(assistant("imported answer"));
		const srcMeta = await src.getMetadata();

		const imported = await repo.importFromJsonl(srcMeta.path, { cwd: "/tmp/imp" });
		const context = await imported.buildContext();
		expect(context.messages).toHaveLength(2);
		expect((context.messages[0] as { content: { text: string }[] }).content[0].text).toBe("imported question");

		const importedMeta = await imported.getMetadata();
		expect(importedMeta.path.endsWith(".db")).toBe(true);
	});

	it("importFromJsonl rejects a malformed / wrong-version file", async () => {
		const badPath = path.join(jsonlRoot, "bad.jsonl");
		await fs.writeFile(badPath, "not json at all\n", "utf8");
		await expect(repo.importFromJsonl(badPath, { cwd: "/tmp/bad" })).rejects.toThrow(/Invalid JSONL/);

		const oldVerPath = path.join(jsonlRoot, "oldver.jsonl");
		await fs.writeFile(
			oldVerPath,
			JSON.stringify({ type: "session", version: 2, id: "old", timestamp: new Date().toISOString(), cwd: "/tmp/bad" }) + "\n",
			"utf8",
		);
		await expect(repo.importFromJsonl(oldVerPath, { cwd: "/tmp/bad" })).rejects.toThrow(/unsupported session version/);
	});

	it("round-trips JSONL → SQLite → JSONL preserving entry payloads", async () => {
		// Source JSONL session.
		const src = await jsonlRepo.create({ cwd: "/tmp/rt" });
		await src.appendMessage(user("first"));
		await src.appendMessage(assistant("second"));
		const srcMeta = await src.getMetadata();
		const srcEntries = await src.getEntries();

		// Import into SQLite, then export back to JSONL.
		const imported = await repo.importFromJsonl(srcMeta.path, { cwd: "/tmp/rt" });
		const importedMeta = await imported.getMetadata();
		const exported = await repo.exportToJsonl(importedMeta);

		const exportedLines = exported.split("\n").filter((l) => l.trim());
		const exportedEntries = exportedLines.slice(1).map((l) => JSON.parse(l));
		// Entry payloads (id/type/message) survive the round-trip identically.
		expect(exportedEntries.map((e) => e.id)).toEqual(srcEntries.map((e) => e.id));
		expect(exportedEntries.map((e) => e.type)).toEqual(srcEntries.map((e) => e.type));
	});

	it("preserves committed context transactions through SQLite export and import", async () => {
		const source = await jsonlRepo.create({ cwd: "/tmp/context-roundtrip" });
		const entries = makeCommittedContextTransaction();
		await source.appendEntries(entries);
		const sourceMeta = await source.getMetadata();

		const imported = await repo.importFromJsonl(sourceMeta.path, { cwd: "/tmp/context-roundtrip" });
		const importedEntries = await imported.getEntries();
		const exported = await repo.exportToJsonl(await imported.getMetadata());

		expect(importedEntries.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
		expect(importedEntries.filter((entry) => entry.type === "custom").map((entry) => entry.customType)).toContain("context_attach");
		expect(foldContextJournal(importedEntries).attachmentsForTurn("context-user")).toHaveLength(1);
		expect(exported).toContain('"customType":"context_projection"');
	});

	it("uses only the transaction structural entries", () => {
		expect(makeCommittedContextTransaction().filter((entry) => entry.type === "custom").map((entry) => entry.customType)).toEqual([
			"context_artifact",
			"context_attach",
			"context_projection",
			"session_tx_manifest",
		]);
	});

	it("replays the committed filtered physical order in one batch", async () => {
		const source = await jsonlRepo.create({ cwd: "/tmp/context-interleaved" });
		const transaction = makeCommittedContextTransaction({ prefix: "interleaved" });
		const ordinary = { type: "message", id: "ordinary-user", parentId: transaction[0]!.id, timestamp: new Date().toISOString(), message: user("ordinary question") } as const;
		const update = {
			type: "custom",
			id: "attachment-update",
			parentId: transaction[1]!.id,
			timestamp: new Date().toISOString(),
			customType: "context_update",
			data: { schemaVersion: 1, attachmentEntryId: transaction[1]!.id, requestedRepresentation: "metadata" },
		} as const;
		await source.appendEntries([transaction[0]!, ordinary, transaction[1]!, update, ...transaction.slice(2)]);
		const sourceEntries = await source.getEntries();

		const imported = await repo.importFromJsonl((await source.getMetadata()).path, { cwd: "/tmp/context-interleaved" });
		const entries = await imported.getEntries();

		expect(entries).toEqual(sourceEntries);
		expect(await imported.getLeafId()).toBe(transaction.at(-1)!.id);
		expect(await imported.getBranch()).toEqual(transaction);
		const importedJournal = foldContextJournal(entries);
		const sourceJournal = foldContextJournal(sourceEntries);
		expect(importedJournal.attachmentsForTurn("interleaved-user")).toEqual(
			sourceJournal.attachmentsForTurn("interleaved-user")
		);
		expect(importedJournal.projectionReports).toEqual(sourceJournal.projectionReports);
		expect(importedJournal.diagnostics).toEqual(sourceJournal.diagnostics);
	});

	it("imports nested relative JSONL paths without resolving them twice", async () => {
		const previousCwd = process.cwd();
		const nestedDir = path.join(jsonlRoot, "exports");
		const inputPath = path.join(nestedDir, "session.jsonl");
		await fs.mkdir(nestedDir, { recursive: true });
		await fs.writeFile(inputPath, `${JSON.stringify({ type: "session", version: 3, id: "nested", timestamp: new Date().toISOString(), cwd: "/tmp/nested" })}\n${JSON.stringify({ type: "message", id: "nested-user", parentId: null, timestamp: new Date().toISOString(), message: user("nested question") })}\n`);
		process.chdir(jsonlRoot);
		try {
			const imported = await repo.importFromJsonl("exports/session.jsonl", { cwd: "/tmp/nested" });
			expect((await imported.getEntries()).map((entry) => entry.id)).toEqual(["nested-user"]);
		} finally {
			process.chdir(previousCwd);
		}
	});

	it("forks before, at, and after a committed context transaction in both carriers", async () => {
		for (const [carrier, sessionRepo] of [["JSONL", jsonlRepo], ["SQLite", repo]] as const) {
			const cwd = `/tmp/context-fork-${carrier}`;
			const source = await sessionRepo.create({ cwd });
			const rootId = await source.appendMessage(user("before context"));
			const transaction = makeCommittedContextTransaction({ parentId: rootId, prefix: `${carrier}-context` });
			await source.appendEntries(transaction);
			const descendantId = await source.appendMessage(assistant("after context"));
			const metadata = await source.getMetadata();
			const transactionUserId = transaction.at(-1)!.id;

			const before = await sessionRepo.fork(metadata, { cwd: `${cwd}-before`, entryId: transactionUserId, position: "before" });
			const at = await sessionRepo.fork(metadata, { cwd: `${cwd}-at`, entryId: transactionUserId, position: "at" });
			const after = await sessionRepo.fork(metadata, { cwd: `${cwd}-after`, entryId: descendantId, position: "at" });

			expect((await before.getEntries()).map((entry) => entry.id)).toEqual([rootId]);
			expect((await at.getEntries()).map((entry) => entry.id)).toEqual([rootId, ...transaction.map((entry) => entry.id)]);
			expect((await after.getEntries()).map((entry) => entry.id)).toEqual([rootId, ...transaction.map((entry) => entry.id), descendantId]);
		}
	});

	it("drops incomplete context transactions when importing JSONL", async () => {
		const entries = makeCommittedContextTransaction();
		const incomplete = entries.filter((entry) => entry.id !== "context-manifest");
		const inputPath = path.join(jsonlRoot, "incomplete.jsonl");
		await fs.writeFile(inputPath, `${JSON.stringify({ type: "session", version: 3, id: "incomplete", timestamp: new Date().toISOString(), cwd: "/tmp/context-roundtrip" })}\n${incomplete.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const imported = await repo.importFromJsonl(inputPath, { cwd: "/tmp/context-roundtrip" });
		const importedEntries = await imported.getEntries();

		expect(importedEntries).toEqual([]);
		expect((await imported.buildContext()).messages).toEqual([]);
		expect(foldContextJournal(importedEntries).attachmentsByTurn.size).toBe(0);
	});

	it("hides incomplete context transactions from JSONL session details", async () => {
		const source = await jsonlRepo.create({ cwd: "/tmp/context-detail" });
		const sourceMeta = await source.getMetadata();
		const incomplete = makeCommittedContextTransaction().filter((entry) => entry.id !== "context-manifest");
		await fs.writeFile(sourceMeta.path, `${JSON.stringify({ type: "session", version: 3, id: sourceMeta.id, timestamp: sourceMeta.createdAt, cwd: sourceMeta.cwd })}\n${incomplete.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const details = await jsonlRepo.listDetails({ cwd: "/tmp/context-detail" });

		expect(details).toEqual([expect.objectContaining({ messageCount: 0, firstMessage: "", previewText: "" })]);
	});
});
