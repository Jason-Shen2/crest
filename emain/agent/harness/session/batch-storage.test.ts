import { describe, expect, it, vi } from "vitest";

import type { AgentMessage } from "../../types";
import { err, FileError, ok, type FileSystem, type Result, type SessionTreeEntry } from "../types";
import { createTransactionManifestData } from "./entry-transaction";
import { JsonlSessionStorage } from "./jsonl-storage";
import { InMemorySessionStorage } from "./memory-storage";
import { Session, buildSessionContext } from "./session";

const timestamp = "2026-07-22T00:00:00.000Z";
const header = { type: "session", version: 3, id: "session", timestamp, cwd: "/tmp" };

function user(id: string, parentId: string | null = null, transactionId?: string): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp,
        message: { role: "user", content: [{ type: "text", text: id }] } as unknown as AgentMessage,
        ...(transactionId == null ? {} : { transactionId }),
    };
}

function assistant(id: string, parentId: string): SessionTreeEntry {
    return {
        type: "message",
        id,
        parentId,
        timestamp,
        message: { role: "assistant", content: [{ type: "text", text: id }], provider: "p", model: "m" } as unknown as AgentMessage,
    };
}

function transaction(transactionId = "tx"): SessionTreeEntry[] {
    const artifact: SessionTreeEntry = {
        type: "custom",
        id: "artifact",
        parentId: null,
        timestamp,
        customType: "context_artifact",
        data: {},
        transactionId,
    };
    const turn = user("turn", "manifest", transactionId);
    const manifest: SessionTreeEntry = {
        type: "custom",
        id: "manifest",
        parentId: "artifact",
        timestamp,
        customType: "session_tx_manifest",
        data: createTransactionManifestData(transactionId, [artifact, turn]),
        transactionId,
    };
    return [artifact, manifest, turn];
}

function incompleteTransaction(): SessionTreeEntry[] {
    return transaction().slice(0, 2);
}

function jsonl(entries: SessionTreeEntry[], suffix = ""): string {
    return `${JSON.stringify(header)}\n${entries.map((entry) => `${JSON.stringify(entry)}\n`).join("")}${suffix}`;
}

function memoryJsonlFile(
    content: string,
    appendResult = ok<void, FileError>(undefined),
    writeResult = ok<void, FileError>(undefined),
) {
    const state = { content };
    const appendFile = vi.fn(async (_path: string, value: string) => {
        if (appendResult.ok) state.content += value;
        return appendResult;
    });
    const writeFile = vi.fn(async (_path: string, value: string) => {
        if (writeResult.ok) state.content = value;
        return writeResult;
    });
    const fs: Pick<FileSystem, "readTextFile" | "readTextLines" | "writeFile" | "appendFile"> = {
        readTextFile: async () => ok(state.content),
        readTextLines: async () => ok(state.content.split("\n")),
        appendFile,
        writeFile,
    };
    return { fs, state, appendFile, writeFile };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((nextResolve) => {
        resolve = nextResolve;
    });
    return { promise, resolve };
}

describe("atomic session batch append", () => {
    it("memory rejects existing and in-batch duplicate IDs without changing the leaf", async () => {
        const storage = new InMemorySessionStorage({ entries: [user("old")] });

        await expect(storage.appendEntries([user("old", "old")])).rejects.toThrow(/duplicate/i);
        await expect(storage.appendEntries([user("one", "old"), user("one", "one")])).rejects.toThrow(/duplicate/i);

        expect((await storage.getEntries()).map((entry) => entry.id)).toEqual(["old"]);
        expect(await storage.getLeafId()).toBe("old");
    });

    it("memory fixture hides an interrupted transaction while preserving normal records", async () => {
        const storage = new InMemorySessionStorage({ entries: [user("ordinary"), ...incompleteTransaction()] });

        expect((await storage.getEntries()).map((entry) => entry.id)).toEqual(["ordinary"]);
        expect(await storage.getLeafId()).toBe("ordinary");
    });

    it("memory and JSONL reject incomplete transactions before mutation", async () => {
        const memory = new InMemorySessionStorage();
        await expect(memory.appendEntries(incompleteTransaction())).rejects.toThrow(/manifest|transaction/i);
        expect(await memory.getEntries()).toEqual([]);

        const file = memoryJsonlFile(jsonl([]));
        const storage = await JsonlSessionStorage.open(file.fs, "/tmp/session.jsonl");
        await expect(storage.appendEntries(incompleteTransaction())).rejects.toThrow(/manifest|transaction/i);
        expect(file.appendFile).not.toHaveBeenCalled();
        expect(await storage.getEntries()).toEqual([]);
    });

    it("JSONL appends a valid batch in one ordered write and commits memory afterward", async () => {
        const file = memoryJsonlFile(jsonl([]));
        const storage = await JsonlSessionStorage.open(file.fs, "/tmp/session.jsonl");
        const entries = transaction();

        await storage.appendEntries(entries);

        expect(file.appendFile).toHaveBeenCalledTimes(1);
        expect(file.appendFile.mock.calls[0]![1]).toBe(entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
        expect((await storage.getEntries()).map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
    });

    it("JSONL append failure leaves memory unchanged", async () => {
        const file = memoryJsonlFile(jsonl([]), err(new FileError("unknown", "disk full")));
        const storage = await JsonlSessionStorage.open(file.fs, "/tmp/session.jsonl");

        await expect(storage.appendEntries([user("turn")])).rejects.toThrow(/append/i);

        expect(await storage.getEntries()).toEqual([]);
        expect(await storage.getLeafId()).toBeNull();
    });

    it("serializes concurrent JSONL appends and continues after an append failure", async () => {
        const file = memoryJsonlFile(jsonl([]));
        const firstResult = deferred<Result<void, FileError>>();
        const appendFile = vi.fn(async (_path: string, value: string) => {
            if (appendFile.mock.calls.length === 1) {
                const result = await firstResult.promise;
                if (result.ok) file.state.content += value;
                return result;
            }
            file.state.content += value;
            return ok<void, FileError>(undefined);
        });
        file.fs.appendFile = appendFile;
        const storage = await JsonlSessionStorage.open(file.fs, "/tmp/session.jsonl");

        const first = storage.appendEntries([user("first")]);
        const second = storage.appendEntries([user("second", "first")]);
        const duplicate = storage.appendEntries([user("first")]);
        await Promise.resolve();
        expect(appendFile).toHaveBeenCalledTimes(1);
        firstResult.resolve(ok(undefined));
        await Promise.all([first, second]);
        await expect(duplicate).rejects.toThrow(/duplicate/i);
        expect(appendFile.mock.calls.map((call) => call[1])).toEqual([
            `${JSON.stringify(user("first"))}\n`,
            `${JSON.stringify(user("second", "first"))}\n`,
        ]);
        expect((await storage.getEntries()).map((entry) => entry.id)).toEqual(["first", "second"]);

        const failedFile = memoryJsonlFile(jsonl([]));
        const failure = deferred<Result<void, FileError>>();
        const failedAppendFile = vi.fn(async (_path: string, value: string) => {
            if (failedAppendFile.mock.calls.length === 1) return failure.promise;
            failedFile.state.content += value;
            return ok<void, FileError>(undefined);
        });
        failedFile.fs.appendFile = failedAppendFile;
        const failedStorage = await JsonlSessionStorage.open(failedFile.fs, "/tmp/failed-session.jsonl");
        const rejected = failedStorage.appendEntries([user("failed")]);
        const stale = failedStorage.appendEntries([user("stale", "failed")]);
        const continued = failedStorage.appendEntries([user("continued")]);
        await Promise.resolve();
        expect(failedAppendFile).toHaveBeenCalledTimes(1);
        failure.resolve(err(new FileError("unknown", "disk full")));
        await expect(rejected).rejects.toThrow(/append/i);
        await expect(stale).rejects.toThrow(/parentId/i);
        await continued;
        expect((await failedStorage.getEntries()).map((entry) => entry.id)).toEqual(["continued"]);
    });

    it("does not recanonicalize a committed transaction before later memory appends", async () => {
        const storage = new InMemorySessionStorage();
        const entries = transaction();
        await storage.appendEntries(entries);
        Object.defineProperty((entries[0] as { data: object }).data, "poison", { value: "ignored", enumerable: false });

        await storage.appendEntries([user("later", "turn")]);

        expect((await storage.getEntries()).map((entry) => entry.id)).toEqual(["artifact", "manifest", "turn", "later"]);
    });

    it("JSONL open removes incomplete groups and a non-newline interrupted tail before accepting later appends", async () => {
        const interrupted = transaction();
        const partialUser = JSON.stringify(interrupted[2]).slice(0, -1);
        const file = memoryJsonlFile(jsonl(interrupted.slice(0, 2), partialUser));

        const storage = await JsonlSessionStorage.open(file.fs, "/tmp/session.jsonl");

        expect(await storage.getEntries()).toEqual([]);
        expect(file.writeFile).toHaveBeenCalledTimes(1);
        await storage.appendEntries([user("later")]);
        expect(file.state.content).toBe(`${JSON.stringify(header)}\n${JSON.stringify(user("later"))}\n`);
    });

    it("JSONL removes a complete unterminated final record before later appends", async () => {
        const prior = user("prior");
        const tail = user("tail", "prior");
        const file = memoryJsonlFile(jsonl([prior], JSON.stringify(tail)));

        const storage = await JsonlSessionStorage.open(file.fs, "/tmp/session.jsonl");

        expect((await storage.getEntries()).map((entry) => entry.id)).toEqual(["prior"]);
        expect(file.writeFile).toHaveBeenCalledTimes(1);
        expect(file.state.content).toBe(`${JSON.stringify(header)}\n${JSON.stringify(prior)}\n`);
        await storage.appendEntries([user("later", "prior")]);
        const reopened = await JsonlSessionStorage.open(file.fs, "/tmp/session.jsonl");
        expect((await reopened.getEntries()).map((entry) => entry.id)).toEqual(["prior", "later"]);
    });

    it("JSONL normalizes an unterminated header before later appends", async () => {
        const file = memoryJsonlFile(JSON.stringify(header));

        const storage = await JsonlSessionStorage.open(file.fs, "/tmp/session.jsonl");

        expect(file.writeFile).toHaveBeenCalledTimes(1);
        expect(file.state.content).toBe(`${JSON.stringify(header)}\n`);
        await storage.appendEntries([user("later")]);
        const reopened = await JsonlSessionStorage.open(file.fs, "/tmp/session.jsonl");
        expect((await reopened.getEntries()).map((entry) => entry.id)).toEqual(["later"]);

        const rewriteFailure = memoryJsonlFile(
            JSON.stringify(header),
            ok(undefined),
            err(new FileError("unknown", "readonly")),
        );
        await expect(JsonlSessionStorage.open(rewriteFailure.fs, "/tmp/session.jsonl")).rejects.toThrow(/recover|session/i);
    });

    it("JSONL rejects newline-terminated malformed records and recovery rewrite failures", async () => {
        const malformed = memoryJsonlFile(`${JSON.stringify(header)}\nnot-json\n`);
        await expect(JsonlSessionStorage.open(malformed.fs, "/tmp/session.jsonl")).rejects.toThrow(/line 2/i);

        const rewriteFailure = memoryJsonlFile(
            jsonl(incompleteTransaction()),
            ok(undefined),
            err(new FileError("unknown", "readonly")),
        );
        await expect(JsonlSessionStorage.open(rewriteFailure.fs, "/tmp/session.jsonl")).rejects.toThrow(/rewrite|recover|session/i);
    });

    it("builds a normal transcript from a committed context transaction", () => {
        const entries = transaction();
        const context = buildSessionContext([...entries, assistant("answer", "turn")]);

        expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
        expect(context.messages).toHaveLength(2);
    });

    it("forwards appendEntries through Session", async () => {
        const storage = new InMemorySessionStorage();
        const session = new Session(storage);
        await session.appendEntries([user("turn")]);
        expect(await session.getLeafId()).toBe("turn");
    });
});
