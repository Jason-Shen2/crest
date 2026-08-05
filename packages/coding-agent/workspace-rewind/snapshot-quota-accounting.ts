// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, join, normalize } from "node:path";

import { encodeDurableJson } from "./durability";
import {
    type AnchoredJournalDirectoryIdentity,
    type AnchoredJournalEntry,
    inspectAnchoredJournalEntry,
    readAnchoredJournalEntry,
    writeAnchoredJournalEntry,
} from "./journal-directory";
import { ensurePrivateCursorRoot, sameDirectoryIdentity } from "./workspace-change-feed-storage";

const QuotaStateName = "quota-v1.json";
const MaximumQuotaStateBytes = 4 * 1024;
const MaximumQuotaStateReadBytes = 1024 * 1024;
const GenerationPattern = /^[0-9a-f]{64}$/;
const AccountingByStoreRoot = new Map<string, Promise<SnapshotQuotaAccounting>>();

export interface StoredQuotaStateV1 {
    schemaversion: 1;
    measuredbytes: number;
    measuredat: string;
    generation: string;
}

export interface SnapshotQuotaAccountingTestHooks {
    beforeStateWrite?(): void | Promise<void>;
    afterStateWrite?(): void | Promise<void>;
}

export class SnapshotQuotaExceededError extends Error {
    readonly code = "quota_exceeded" as const;
    readonly measuredBytes: number;
    readonly requestedBytes: number;
    readonly maxBytes: number;

    constructor(input: { measuredBytes: number; requestedBytes: number; maxBytes: number }) {
        super("Workspace checkpoint quota exceeded");
        this.name = "SnapshotQuotaExceededError";
        this.measuredBytes = input.measuredBytes;
        this.requestedBytes = input.requestedBytes;
        this.maxBytes = input.maxBytes;
    }
}

export class SnapshotQuotaReservation {
    readonly accounting: SnapshotQuotaAccounting;
    readonly reservedBytes: number;
    status: "active" | "resolved" = "active";
    needsExactSettlement = false;

    constructor(accounting: SnapshotQuotaAccounting, reservedBytes: number) {
        this.accounting = accounting;
        this.reservedBytes = reservedBytes;
    }

    commit(input: { actualNewLooseBytes: number }): Promise<void> {
        return this.accounting.commitReservation(this, input.actualNewLooseBytes);
    }

    release(): Promise<void> {
        return this.accounting.releaseReservation(this);
    }

    invalidate(): Promise<void> {
        return this.accounting.invalidateReservation(this);
    }
}

export class SnapshotQuotaAccounting {
    readonly storeRoot: string;
    readonly maxBytes: number;
    readonly generation: string;
    readonly measureExactUsage: () => Promise<number>;
    readonly testHooks?: SnapshotQuotaAccountingTestHooks;
    rootIdentity!: AnchoredJournalDirectoryIdentity;
    stateEntry?: AnchoredJournalEntry;
    measuredBytes = 0;
    activeReservedBytes = 0;
    activeReservations = new Set<SnapshotQuotaReservation>();
    needsReconcile = false;
    serialized: Promise<void> = Promise.resolve();

    constructor(input: {
        storeRoot: string;
        maxBytes: number;
        generation: string;
        measureExactUsage: () => Promise<number>;
        testHooks?: SnapshotQuotaAccountingTestHooks;
    }) {
        this.storeRoot = input.storeRoot;
        this.maxBytes = input.maxBytes;
        this.generation = input.generation;
        this.measureExactUsage = input.measureExactUsage;
        this.testHooks = input.testHooks;
    }

    static open(input: {
        storeRoot: string;
        maxBytes: number;
        generation: string;
        measureExactUsage: () => Promise<number>;
        testHooks?: SnapshotQuotaAccountingTestHooks;
    }): Promise<SnapshotQuotaAccounting> {
        validateOpenInput(input);
        const existing = AccountingByStoreRoot.get(input.storeRoot);
        if (existing) {
            return existing.then((accounting) => {
                if (accounting.maxBytes !== input.maxBytes || accounting.generation !== input.generation) {
                    throw new Error("Snapshot quota accounting configuration changed within one process");
                }
                return accounting.refreshAfterStoreOpen();
            });
        }
        const accounting = new SnapshotQuotaAccounting(input);
        const opening = accounting.open().catch((error) => {
            if (AccountingByStoreRoot.get(input.storeRoot) === opening) {
                AccountingByStoreRoot.delete(input.storeRoot);
            }
            throw error;
        });
        AccountingByStoreRoot.set(input.storeRoot, opening);
        return opening;
    }

    async open(): Promise<SnapshotQuotaAccounting> {
        this.rootIdentity = await ensurePrivateCursorRoot(join(this.storeRoot, "tracker"));
        let loaded:
            | { state: StoredQuotaStateV1; entry: AnchoredJournalEntry; rootIdentity: AnchoredJournalDirectoryIdentity }
            | undefined;
        try {
            loaded = await this.readStoredState();
        } catch (error) {
            if (!isRecoverableStateReadError(error)) {
                const oversized = await this.inspectHardOversizedState();
                if (!oversized) throw error;
                this.rootIdentity = oversized.identity;
                this.stateEntry = oversized.entry;
            }
        }
        if (loaded && loaded.state.generation === this.generation) {
            this.rootIdentity = loaded.rootIdentity;
            this.stateEntry = loaded.entry;
            this.measuredBytes = loaded.state.measuredbytes;
            return this;
        }
        if (loaded) {
            this.rootIdentity = loaded.rootIdentity;
            this.stateEntry = loaded.entry;
        } else if (!this.stateEntry) {
            const raw = await this.readRawStateForReplacement();
            if (raw) {
                this.rootIdentity = raw.identity;
                this.stateEntry = raw.entry;
            }
        }
        await this.reconcileExactUsage();
        return this;
    }

    reserve(input: { contentBytes: number; metadataBytes: number }): Promise<SnapshotQuotaReservation> {
        validateBytes(input.contentBytes, "quota content reservation");
        validateBytes(input.metadataBytes, "quota metadata reservation");
        const reservedBytes = checkedAdd(input.contentBytes, input.metadataBytes, "quota reservation");
        return this.runSerialized(async () => {
            if (this.needsReconcile) await this.reconcileExactUsageUnlocked();
            if (reservedBytes > this.maxBytes - this.measuredBytes) {
                throw new SnapshotQuotaExceededError({
                    measuredBytes: this.measuredBytes,
                    requestedBytes: reservedBytes,
                    maxBytes: this.maxBytes,
                });
            }
            await this.publishMeasuredBytes(this.measuredBytes + reservedBytes);
            const reservation = new SnapshotQuotaReservation(this, reservedBytes);
            this.activeReservations.add(reservation);
            this.activeReservedBytes = checkedAdd(this.activeReservedBytes, reservedBytes, "active quota reservations");
            return reservation;
        });
    }

    reconcileExactUsage(): Promise<number> {
        return this.runSerialized(() => this.reconcileExactUsageUnlocked());
    }

    refreshAfterStoreOpen(): Promise<SnapshotQuotaAccounting> {
        return this.runSerialized(async () => {
            const current = await readAnchoredJournalEntry({
                root: join(this.storeRoot, "tracker"),
                name: QuotaStateName,
                maximumEntryBytes: MaximumQuotaStateReadBytes,
            });
            if (!current || !sameDirectoryIdentity(current.identity, this.rootIdentity)) {
                throw new Error("Snapshot quota tracker root anchor changed");
            }
            if (current.entry && isEquivalentStoredState(current.entry.bytes, this.generation, this.measuredBytes)) {
                this.stateEntry = current.entry;
                return this;
            }
            this.stateEntry = current.entry;
            this.needsReconcile = true;
            await this.reconcileExactUsageUnlocked();
            return this;
        });
    }

    replaceExactUsage(measuredBytes: number): Promise<void> {
        validateBytes(measuredBytes, "exact snapshot usage");
        return this.runSerialized(async () => {
            this.markActiveReservationsForExactSettlement();
            await this.publishMeasuredBytes(
                checkedAdd(measuredBytes, this.activeReservedBytes, "snapshot usage with active reservations")
            );
            this.needsReconcile = false;
        });
    }

    markNeedsReconcile(): void {
        this.needsReconcile = true;
    }

    commitReservation(reservation: SnapshotQuotaReservation, actualNewLooseBytes: number): Promise<void> {
        validateBytes(actualNewLooseBytes, "new loose object usage");
        return this.runSerialized(async () => {
            if (reservation.status === "resolved") return;
            if (
                this.needsReconcile ||
                reservation.needsExactSettlement ||
                actualNewLooseBytes > reservation.reservedBytes
            ) {
                this.resolveReservation(reservation);
                this.needsReconcile = true;
                const measuredBytes = await this.reconcileExactUsageUnlocked();
                if (actualNewLooseBytes > reservation.reservedBytes || measuredBytes > this.maxBytes) {
                    throw new SnapshotQuotaExceededError({
                        measuredBytes,
                        requestedBytes: actualNewLooseBytes,
                        maxBytes: this.maxBytes,
                    });
                }
                return;
            }
            const next = this.measuredBytes - reservation.reservedBytes + actualNewLooseBytes;
            try {
                await this.publishMeasuredBytes(next);
                this.resolveReservation(reservation);
            } catch (error) {
                this.resolveReservation(reservation);
                this.needsReconcile = true;
                throw error;
            }
        });
    }

    releaseReservation(reservation: SnapshotQuotaReservation): Promise<void> {
        return this.runSerialized(async () => {
            if (reservation.status === "resolved") return;
            if (this.needsReconcile || reservation.needsExactSettlement) {
                this.resolveReservation(reservation);
                await this.reconcileExactUsageUnlocked();
                return;
            }
            try {
                await this.publishMeasuredBytes(this.measuredBytes - reservation.reservedBytes);
                this.resolveReservation(reservation);
            } catch (error) {
                this.resolveReservation(reservation);
                this.needsReconcile = true;
                throw error;
            }
        });
    }

    invalidateReservation(reservation: SnapshotQuotaReservation): Promise<void> {
        return this.runSerialized(async () => {
            if (reservation.status === "resolved") return;
            this.resolveReservation(reservation);
            this.needsReconcile = true;
        });
    }

    async reconcileExactUsageUnlocked(): Promise<number> {
        const current = await this.readCurrentStateForReconciliation();
        if (!current || !sameDirectoryIdentity(current.identity, this.rootIdentity)) {
            throw new Error("Snapshot quota tracker root anchor changed");
        }
        this.stateEntry = current.entry;
        this.markActiveReservationsForExactSettlement();
        const measuredBytes = await this.measureExactUsage();
        validateBytes(measuredBytes, "exact snapshot usage");
        const measuredWithReservations = checkedAdd(
            measuredBytes,
            this.activeReservedBytes,
            "snapshot usage with active reservations"
        );
        await this.publishMeasuredBytes(measuredWithReservations);
        this.needsReconcile = false;
        return measuredWithReservations;
    }

    async publishMeasuredBytes(measuredBytes: number): Promise<void> {
        validateBytes(measuredBytes, "snapshot quota usage");
        const state: StoredQuotaStateV1 = {
            schemaversion: 1,
            measuredbytes: measuredBytes,
            measuredat: new Date().toISOString(),
            generation: this.generation,
        };
        const bytes = encodeDurableJson(state);
        if (bytes.length > MaximumQuotaStateBytes) throw new Error("Snapshot quota state exceeds maximum size");
        await this.testHooks?.beforeStateWrite?.();
        await writeAnchoredJournalEntry({
            root: join(this.storeRoot, "tracker"),
            rootIdentity: this.rootIdentity,
            destinationName: QuotaStateName,
            bytes,
            expectedDestination: this.stateEntry,
        });
        await this.testHooks?.afterStateWrite?.();
        const published = await readAnchoredJournalEntry({
            root: join(this.storeRoot, "tracker"),
            name: QuotaStateName,
            maximumEntryBytes: MaximumQuotaStateReadBytes,
        });
        if (
            !published?.entry ||
            !published.entry.bytes.equals(bytes) ||
            !sameDirectoryIdentity(published.identity, this.rootIdentity)
        ) {
            throw new Error("Snapshot quota state publication failed validation");
        }
        this.stateEntry = published.entry;
        this.measuredBytes = measuredBytes;
    }

    async readStoredState(): Promise<
        | { state: StoredQuotaStateV1; entry: AnchoredJournalEntry; rootIdentity: AnchoredJournalDirectoryIdentity }
        | undefined
    > {
        const stored = await readAnchoredJournalEntry({
            root: join(this.storeRoot, "tracker"),
            name: QuotaStateName,
            maximumEntryBytes: MaximumQuotaStateReadBytes,
        });
        if (!stored?.entry) return undefined;
        if (stored.entry.bytes.length > MaximumQuotaStateBytes) return undefined;
        const value: unknown = JSON.parse(stored.entry.bytes.toString("utf8"));
        if (!encodeDurableJson(value).equals(stored.entry.bytes)) return undefined;
        return { state: decodeState(value), entry: stored.entry, rootIdentity: stored.identity };
    }

    async readRawStateForReplacement(): Promise<
        { identity: AnchoredJournalDirectoryIdentity; entry: AnchoredJournalEntry } | undefined
    > {
        const stored = await readAnchoredJournalEntry({
            root: join(this.storeRoot, "tracker"),
            name: QuotaStateName,
            maximumEntryBytes: MaximumQuotaStateReadBytes,
        });
        if (!stored?.entry) return undefined;
        return { identity: stored.identity, entry: stored.entry };
    }

    async inspectHardOversizedState(): Promise<
        { identity: AnchoredJournalDirectoryIdentity; entry: AnchoredJournalEntry } | undefined
    > {
        const inspected = await inspectAnchoredJournalEntry({
            root: join(this.storeRoot, "tracker"),
            name: QuotaStateName,
        });
        if (!inspected?.entry || BigInt(inspected.entry.identity.size) <= BigInt(MaximumQuotaStateReadBytes)) {
            return undefined;
        }
        return {
            identity: inspected.identity,
            entry: { ...inspected.entry, bytes: Buffer.alloc(0) },
        };
    }

    async readCurrentStateForReconciliation(): Promise<
        { identity: AnchoredJournalDirectoryIdentity; entry: AnchoredJournalEntry | undefined } | undefined
    > {
        try {
            return await readAnchoredJournalEntry({
                root: join(this.storeRoot, "tracker"),
                name: QuotaStateName,
                maximumEntryBytes: MaximumQuotaStateReadBytes,
            });
        } catch (error) {
            const oversized = await this.inspectHardOversizedState();
            if (!oversized) throw error;
            return oversized;
        }
    }

    markActiveReservationsForExactSettlement(): void {
        for (const reservation of this.activeReservations) reservation.needsExactSettlement = true;
    }

    resolveReservation(reservation: SnapshotQuotaReservation): void {
        if (!this.activeReservations.delete(reservation)) {
            throw new Error("Snapshot quota reservation is not active");
        }
        this.activeReservedBytes -= reservation.reservedBytes;
        reservation.status = "resolved";
    }

    runSerialized<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.serialized.then(operation, operation);
        this.serialized = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }
}

export function resetSnapshotQuotaAccountingRegistryForTest(): void {
    AccountingByStoreRoot.clear();
}

function decodeState(value: unknown): StoredQuotaStateV1 {
    if (
        !isRecord(value) ||
        Object.keys(value).sort().join(",") !== "generation,measuredat,measuredbytes,schemaversion" ||
        value.schemaversion !== 1 ||
        !GenerationPattern.test(value.generation as string) ||
        typeof value.measuredat !== "string" ||
        !isCanonicalTimestamp(value.measuredat)
    ) {
        throw new Error("Invalid snapshot quota state");
    }
    validateBytes(value.measuredbytes, "snapshot quota state usage");
    return {
        schemaversion: 1,
        measuredbytes: value.measuredbytes as number,
        measuredat: value.measuredat,
        generation: value.generation as string,
    };
}

function isEquivalentStoredState(bytes: Buffer, generation: string, measuredBytes: number): boolean {
    try {
        if (bytes.length > MaximumQuotaStateBytes) return false;
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        if (!encodeDurableJson(value).equals(bytes)) return false;
        const state = decodeState(value);
        return state.generation === generation && state.measuredbytes === measuredBytes;
    } catch {
        return false;
    }
}

function isCanonicalTimestamp(value: string): boolean {
    const parsed = new Date(value);
    return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function validateOpenInput(input: {
    storeRoot: string;
    maxBytes: number;
    generation: string;
    measureExactUsage: unknown;
}): void {
    if (!isAbsolute(input.storeRoot) || normalize(input.storeRoot) !== input.storeRoot) {
        throw new Error("Invalid snapshot quota store root");
    }
    validateBytes(input.maxBytes, "snapshot quota maximum");
    if (input.maxBytes === 0 || !GenerationPattern.test(input.generation)) {
        throw new Error("Invalid snapshot quota configuration");
    }
    if (typeof input.measureExactUsage !== "function") throw new Error("Invalid exact snapshot usage reader");
}

function validateBytes(value: unknown, label: string): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Invalid ${label}`);
    }
}

function checkedAdd(left: number, right: number, label: string): number {
    const sum = left + right;
    if (!Number.isSafeInteger(sum)) throw new Error(`${label} exceeds the supported range`);
    return sum;
}

function isRecoverableStateReadError(error: unknown): boolean {
    return (
        error instanceof SyntaxError || (error instanceof Error && /invalid snapshot quota state/i.test(error.message))
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value != null && !Array.isArray(value);
}
