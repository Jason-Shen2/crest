// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type { SessionTreeEntry } from "../types";

export const SessionTransactionManifestCustomType = "session_tx_manifest";

export interface SessionTransactionManifestData {
    schemaVersion: 1;
    transactionId: string;
    orderedMemberEntryIds: string[];
    userEntryId: string;
    membersSha256: string;
}

export interface SessionEntryTransactionDiagnostic {
    message: string;
    transactionId?: string;
}

export interface CommittedTransactionEntriesResult {
    entries: SessionTreeEntry[];
    diagnostics: SessionEntryTransactionDiagnostic[];
    committedTransactionIds: Set<string>;
    committedTransactions: Map<string, CommittedSessionEntryTransaction>;
}

export interface CommittedSessionEntryTransaction {
    transactionId: string;
    manifest: SessionTreeEntry;
    physicalEntries: SessionTreeEntry[];
    members: SessionTreeEntry[];
    userEntryId: string;
}

export class SessionEntryTransactionError extends Error {
    code: "invalid_json" | "invalid_transaction";

    constructor(code: SessionEntryTransactionError["code"], message: string) {
        super(message);
        this.name = "SessionEntryTransactionError";
        this.code = code;
    }
}

function invalidJson(message: string): never {
    throw new SessionEntryTransactionError("invalid_json", message);
}

function readOwnValue(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) invalidJson(`JSON object field ${key} must be a data property`);
    return descriptor.value;
}

function hasOwnValue(value: object, key: string): boolean {
    return Object.hasOwn(value, key);
}

function isPlainObject(value: object): value is Record<string, unknown> {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function readArrayValues(value: unknown, field: string): unknown[] {
    if (!Array.isArray(value)) invalidJson(`${field} must be an array`);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") {
        invalidJson(`${field} has an invalid length`);
    }
    const length = lengthDescriptor.value;
    const names = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length > 0 || names.length !== length + 1 || !names.includes("length")) {
        invalidJson(`${field} must contain only indexed data properties`);
    }
    const result = new Array<unknown>(length);
    for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) invalidJson(`${field} must not contain holes or accessors`);
        result[index] = descriptor.value;
    }
    return result;
}

function copyJsonValue(value: unknown, ancestors = new WeakSet<object>()): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) invalidJson("JSON numbers must be finite");
        return value;
    }
    if (typeof value !== "object") invalidJson("Value is not JSON serializable");
    if (ancestors.has(value)) invalidJson("JSON values must not contain cycles");
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return readArrayValues(value, "JSON arrays").map((item) => copyJsonValue(item, ancestors));
        }
        if (!isPlainObject(value)) invalidJson("JSON objects must have a plain prototype");
        if (Object.getOwnPropertySymbols(value).length > 0) invalidJson("JSON objects must not contain symbol keys");
        const result = Object.create(null) as Record<string, unknown>;
        for (const key of Object.getOwnPropertyNames(value).sort()) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
                invalidJson("JSON objects must contain only enumerable data properties");
            }
            result[key] = copyJsonValue(descriptor.value, ancestors);
        }
        return result;
    } finally {
        ancestors.delete(value);
    }
}

export function canonicalJson(value: unknown): string {
    return JSON.stringify(copyJsonValue(value));
}

export function sha256CanonicalJson(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function requiredString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new SessionEntryTransactionError("invalid_transaction", `${field} must be a non-empty string`);
    }
    return value;
}

function transactionIdForEntry(entry: SessionTreeEntry): string | undefined {
    if (!hasOwnValue(entry, "transactionId")) return undefined;
    const transactionId = readOwnValue(entry, "transactionId");
    return requiredString(transactionId, "transactionId");
}

function entryId(entry: SessionTreeEntry): string {
    return requiredString(readOwnValue(entry, "id"), "entry ID");
}

function parentId(entry: SessionTreeEntry): string | null {
    const value = readOwnValue(entry, "parentId");
    if (value === null) return null;
    if (typeof value === "string") return value;
    throw new SessionEntryTransactionError("invalid_transaction", "entry parentId must be a string or null");
}

function isUserEntry(entry: SessionTreeEntry): boolean {
    if (readOwnValue(entry, "type") !== "message") return false;
    const message = readOwnValue(entry, "message");
    return typeof message === "object" && message != null && readOwnValue(message, "role") === "user";
}

function manifestData(entry: SessionTreeEntry): SessionTransactionManifestData | undefined {
    if (readOwnValue(entry, "type") !== "custom" || readOwnValue(entry, "customType") !== SessionTransactionManifestCustomType) {
        return undefined;
    }
    const data = readOwnValue(entry, "data");
    if (typeof data !== "object" || data == null || Array.isArray(data)) {
        throw new SessionEntryTransactionError("invalid_transaction", "Transaction manifest data must be an object");
    }
    if (readOwnValue(data, "schemaVersion") !== 1) {
        throw new SessionEntryTransactionError("invalid_transaction", "Transaction manifest schemaVersion must be 1");
    }
    const transactionId = requiredString(readOwnValue(data, "transactionId"), "manifest transactionId");
    const userEntryId = requiredString(readOwnValue(data, "userEntryId"), "manifest userEntryId");
    const membersSha256 = requiredString(readOwnValue(data, "membersSha256"), "manifest membersSha256");
    const ordered = readArrayValues(readOwnValue(data, "orderedMemberEntryIds"), "manifest orderedMemberEntryIds");
    if (ordered.length === 0) {
        throw new SessionEntryTransactionError("invalid_transaction", "manifest orderedMemberEntryIds must be a non-empty array");
    }
    const orderedMemberEntryIds = ordered.map((item) => requiredString(item, "manifest member entry ID"));
    return { schemaVersion: 1, transactionId, orderedMemberEntryIds, userEntryId, membersSha256 };
}

export function createTransactionManifestData(transactionId: string, members: SessionTreeEntry[]): SessionTransactionManifestData {
    const safeMembers = readArrayValues(members, "Transaction members") as SessionTreeEntry[];
    if (safeMembers.length === 0) {
        throw new SessionEntryTransactionError("invalid_transaction", "Transaction must contain a user member");
    }
    for (const member of safeMembers) {
        if (transactionIdForEntry(member) !== transactionId) {
            throw new SessionEntryTransactionError("invalid_transaction", "Transaction member IDs must match the manifest transaction ID");
        }
    }
    const user = safeMembers.at(-1)!;
    if (!isUserEntry(user)) {
        throw new SessionEntryTransactionError("invalid_transaction", "Transaction user member must be last");
    }
    return {
        schemaVersion: 1,
        transactionId,
        orderedMemberEntryIds: safeMembers.map(entryId),
        userEntryId: entryId(user),
        membersSha256: sha256CanonicalJson(safeMembers),
    };
}

function validateGroup(transactionId: string, group: SessionTreeEntry[]): { issue?: string; transaction?: CommittedSessionEntryTransaction } {
    try {
        const manifests = group.filter((entry) => manifestData(entry) != null);
        if (manifests.length !== 1) return { issue: "transaction must have exactly one manifest" };
        const manifest = manifests[0]!;
        const data = manifestData(manifest)!;
        if (data.transactionId !== transactionId) return { issue: "manifest transactionId does not match entry transactionId" };
        const manifestIndex = group.indexOf(manifest);
        if (manifestIndex !== group.length - 2) return { issue: "manifest must precede the final user member" };
        const members = group.filter((entry) => entry !== manifest);
        const actualIds = members.map(entryId);
        const physicalEntryIds = group.map(entryId);
        if (new Set(physicalEntryIds).size !== group.length) {
            return { issue: "transaction entry IDs must be unique" };
        }
        if (actualIds.length !== data.orderedMemberEntryIds.length || actualIds.some((id, index) => id !== data.orderedMemberEntryIds[index])) {
            return { issue: "manifest ordered member IDs do not match transaction entries" };
        }
        const user = members.at(-1);
        if (!user || !isUserEntry(user) || entryId(user) !== data.userEntryId) return { issue: "manifest user member must be the final user entry" };
        if (data.membersSha256 !== sha256CanonicalJson(members)) return { issue: "manifest member digest does not match transaction entries" };
        if (parentId(group[0]!) != null && physicalEntryIds.includes(parentId(group[0]!)!)) {
            return { issue: "first transaction entry parent must be outside its group" };
        }
        for (let index = 1; index < group.length; index++) {
            if (parentId(group[index]!) !== entryId(group[index - 1]!)) {
                return { issue: "transaction entries must form one physical ancestor chain" };
            }
        }
        return {
            transaction: {
                transactionId,
                manifest,
                physicalEntries: group,
                members,
                userEntryId: data.userEntryId,
            },
        };
    } catch (error) {
        return { issue: error instanceof Error ? error.message : "invalid transaction" };
    }
}

export function filterCommittedTransactionEntries(entries: SessionTreeEntry[]): CommittedTransactionEntriesResult {
    const inputEntries = readArrayValues(entries, "Session entries") as SessionTreeEntry[];
    const groups = new Map<string, SessionTreeEntry[]>();
    const diagnostics: SessionEntryTransactionDiagnostic[] = [];
    const entryIdCounts = new Map<string, number>();
    const entryIds = new Map<SessionTreeEntry, string>();

    for (const entry of inputEntries) {
        try {
            const id = entryId(entry);
            entryIdCounts.set(id, (entryIdCounts.get(id) ?? 0) + 1);
            entryIds.set(entry, id);
        } catch (error) {
            diagnostics.push({ message: error instanceof Error ? error.message : "invalid session entry ID" });
        }
    }
    const duplicateEntryIds = new Set([...entryIdCounts].filter(([, count]) => count > 1).map(([id]) => id));
    for (const id of duplicateEntryIds) {
        diagnostics.push({ message: `duplicate session entry ID ${id}` });
    }

    for (const entry of inputEntries) {
        try {
            const transactionId = transactionIdForEntry(entry);
            if (transactionId == null) {
                continue;
            }
            const group = groups.get(transactionId) ?? [];
            group.push(entry);
            groups.set(transactionId, group);
        } catch (error) {
            diagnostics.push({ message: error instanceof Error ? error.message : "invalid transaction entry" });
        }
    }

    const committedTransactionIds = new Set<string>();
    const committedTransactions = new Map<string, CommittedSessionEntryTransaction>();
    for (const [transactionId, group] of groups) {
        if (group.some((entry) => {
            const id = entryIds.get(entry);
            return id == null || duplicateEntryIds.has(id);
        })) continue;
        const result = validateGroup(transactionId, group);
        if (result.transaction) {
            committedTransactionIds.add(transactionId);
            committedTransactions.set(transactionId, result.transaction);
        } else {
            diagnostics.push({ transactionId, message: result.issue ?? "invalid transaction" });
        }
    }

    const visibleEntries = inputEntries.filter((entry) => {
        try {
            const id = entryIds.get(entry);
            if (id == null || duplicateEntryIds.has(id)) return false;
            const transactionId = transactionIdForEntry(entry);
            return transactionId == null || committedTransactionIds.has(transactionId);
        } catch {
            return false;
        }
    });
    return { entries: visibleEntries, diagnostics, committedTransactionIds, committedTransactions };
}

/** Reject a programmatic append unless every proposed entry remains visible after transaction validation. */
export function validateSessionEntriesForAppend(existingEntries: SessionTreeEntry[], entries: SessionTreeEntry[]): void {
    const allEntries = [...existingEntries, ...entries];
    for (const entry of allEntries) {
        try {
            entryId(entry);
        } catch (error) {
            throw new SessionEntryTransactionError(
                "invalid_transaction",
                error instanceof Error ? error.message : "invalid session entry ID",
            );
        }
    }
    const result = filterCommittedTransactionEntries(allEntries);
    if (result.diagnostics.length > 0) {
        throw new SessionEntryTransactionError("invalid_transaction", result.diagnostics[0]!.message);
    }
    if (result.entries.length !== allEntries.length || result.entries.some((entry, index) => entry !== allEntries[index])) {
        throw new SessionEntryTransactionError("invalid_transaction", "session entries did not form complete transactions");
    }
}

export function getTransactionForkBoundary(
    entries: SessionTreeEntry[],
    entryIdToFork: string,
    position: "before" | "at"
): string | null {
    const result = filterCommittedTransactionEntries(entries);
    const target = result.entries.find((entry) => {
        try {
            return entryId(entry) === entryIdToFork;
        } catch {
            return false;
        }
    });
    if (!target) return null;
    try {
        const transactionId = transactionIdForEntry(target);
        if (position === "at") return entryId(target);
        if (transactionId == null) return parentId(target);
        const transaction = result.committedTransactions.get(transactionId);
        if (transaction == null) return null;
        return parentId(transaction.physicalEntries[0]!);
    } catch {
        return null;
    }
}
