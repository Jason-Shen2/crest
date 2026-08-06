// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WorkspaceSnapshotStoreError } from "../../packages/coding-agent/workspace-rewind/snapshot-store";

export const AgentRewindResultSchema = "agent-rewind-real-workspace-result";
export const AgentRewindResultVersion = 1;
export const AgentRewindVerifiedBaselineCommit = "a1980580";

export type ScenarioStatus = "completed" | "failed" | "baseline-unavailable" | "skipped";
export type RepositorySupport = "unsupported" | "baseline-only" | "end-to-end-supported";

export interface ResultEnvironment {
    platform: string;
    architecture: string;
    nodeversion: string;
    baselinecommit: string;
}

export interface RepositoryDescriptor {
    input: string;
    fingerprint: string;
}

export interface WorkspaceScope {
    filecount: number;
    bytecount: number;
}

export interface CaptureMetric extends WorkspaceScope {
    status: ScenarioStatus;
    durationms: number;
    newbytes: number;
}

export interface ScenarioMetric {
    status: ScenarioStatus;
    durationms: number;
}

export interface ExactBytesMetric extends ScenarioMetric {
    matches: boolean;
}

export interface IntegrityMetric extends ScenarioMetric {
    clean: boolean;
}

export interface ResourcePeak {
    rssbytes: number;
    heapbytes: number;
}

export interface ResultFailure {
    code: WorkspaceSnapshotStoreError["code"] | "unexpected";
    message: string;
}

export interface RepositorySupportEvidence {
    capture: {
        cold: CaptureMetric;
        warm: CaptureMetric;
    };
    scenarios: {
        undo: ScenarioMetric;
        redo: ScenarioMetric;
        exactbytes: ExactBytesMetric;
    };
    gitintegrity: IntegrityMetric;
    sourceintegrity: IntegrityMetric;
    cleanup: ScenarioMetric;
}

export interface AgentRewindResultDocument extends RepositorySupportEvidence {
    schema: typeof AgentRewindResultSchema;
    version: typeof AgentRewindResultVersion;
    environment: ResultEnvironment;
    repository: RepositoryDescriptor;
    scope: WorkspaceScope;
    resourcepeak: ResourcePeak;
    support: RepositorySupport;
    failure?: ResultFailure;
}

export interface VerifiedProductCeiling {
    maxfilecount: number;
    maxbytecount: number;
}

export interface ResultValidation {
    valid: boolean;
    errors: string[];
}

const ScenarioStatuses = new Set<ScenarioStatus>(["completed", "failed", "baseline-unavailable", "skipped"]);
const RepositorySupports = new Set<RepositorySupport>(["unsupported", "baseline-only", "end-to-end-supported"]);
const FailureCodes = new Set<ResultFailure["code"]>([
    "capture_timeout",
    "capture_budget",
    "unstable_file",
    "enospc",
    "quota_exceeded",
    "corrupt_snapshot",
    "unexpected",
]);

export function classifyRepositorySupport(evidence: RepositorySupportEvidence): RepositorySupport {
    const endToEndSupported =
        evidence.capture.cold.status === "completed" &&
        evidence.scenarios.undo.status === "completed" &&
        evidence.scenarios.redo.status === "completed" &&
        evidence.scenarios.exactbytes.status === "completed" &&
        evidence.scenarios.exactbytes.matches &&
        evidence.gitintegrity.status === "completed" &&
        evidence.gitintegrity.clean &&
        evidence.sourceintegrity.status === "completed" &&
        evidence.sourceintegrity.clean &&
        evidence.cleanup.status === "completed";
    if (endToEndSupported) return "end-to-end-supported";
    if (evidence.capture.cold.status === "completed" && evidence.scenarios.undo.status === "baseline-unavailable") {
        return "baseline-only";
    }
    return "unsupported";
}

export function computeVerifiedProductCeiling(
    results: readonly AgentRewindResultDocument[]
): VerifiedProductCeiling | undefined {
    const verified = results.filter((result) => classifyRepositorySupport(result) === "end-to-end-supported");
    if (verified.length === 0) return undefined;
    return {
        maxfilecount: Math.max(...verified.map((result) => result.scope.filecount)),
        maxbytecount: Math.max(...verified.map((result) => result.scope.bytecount)),
    };
}

export function normalizeCaptureFailure(error: unknown): ResultFailure {
    if (error instanceof WorkspaceSnapshotStoreError) {
        return { code: error.code, message: error.message };
    }
    if (error instanceof Error) {
        return { code: "unexpected", message: error.message };
    }
    return { code: "unexpected", message: "Unknown capture failure" };
}

export function validateResultDocument(document: unknown): ResultValidation {
    const errors: string[] = [];
    if (!isRecord(document)) return { valid: false, errors: ["document must be an object"] };

    validateSerializationFields(document, errors);
    if (document.schema !== AgentRewindResultSchema) errors.push("schema is invalid");
    if (document.version !== AgentRewindResultVersion) errors.push("version is invalid");

    const environment = requireRecord(document, "environment", errors);
    if (environment != null) {
        requireString(environment, "platform", "environment.platform", errors);
        requireString(environment, "architecture", "environment.architecture", errors);
        requireString(environment, "nodeversion", "environment.nodeversion", errors);
        requireString(environment, "baselinecommit", "environment.baselinecommit", errors);
        if (environment.baselinecommit !== AgentRewindVerifiedBaselineCommit) {
            errors.push("environment.baselinecommit is not verified");
        }
    }

    const repository = requireRecord(document, "repository", errors);
    if (repository != null) {
        requireString(repository, "input", "repository.input", errors);
        requireString(repository, "fingerprint", "repository.fingerprint", errors);
    }

    const scope = requireRecord(document, "scope", errors);
    if (scope != null) validateScope(scope, "scope", errors);

    const capture = requireRecord(document, "capture", errors);
    const cold = capture == null ? undefined : requireRecord(capture, "cold", errors, "capture.cold");
    const warm = capture == null ? undefined : requireRecord(capture, "warm", errors, "capture.warm");
    if (cold != null) validateCaptureMetric(cold, "capture.cold", errors);
    if (warm != null) validateCaptureMetric(warm, "capture.warm", errors);

    const scenarios = requireRecord(document, "scenarios", errors);
    const undo = scenarios == null ? undefined : requireRecord(scenarios, "undo", errors, "scenarios.undo");
    const redo = scenarios == null ? undefined : requireRecord(scenarios, "redo", errors, "scenarios.redo");
    const exactbytes =
        scenarios == null ? undefined : requireRecord(scenarios, "exactbytes", errors, "scenarios.exactbytes");
    if (undo != null) validateScenarioMetric(undo, "scenarios.undo", errors);
    if (redo != null) validateScenarioMetric(redo, "scenarios.redo", errors);
    if (exactbytes != null) {
        validateScenarioMetric(exactbytes, "scenarios.exactbytes", errors);
        requireBoolean(exactbytes, "matches", "scenarios.exactbytes.matches", errors);
    }

    const resourcepeak = requireRecord(document, "resourcepeak", errors);
    if (resourcepeak != null) {
        requireNonnegativeNumber(resourcepeak, "rssbytes", "resourcepeak.rssbytes", errors);
        requireNonnegativeNumber(resourcepeak, "heapbytes", "resourcepeak.heapbytes", errors);
    }

    const gitintegrity = requireRecord(document, "gitintegrity", errors);
    const sourceintegrity = requireRecord(document, "sourceintegrity", errors);
    const cleanup = requireRecord(document, "cleanup", errors);
    if (gitintegrity != null) validateIntegrityMetric(gitintegrity, "gitintegrity", errors);
    if (sourceintegrity != null) validateIntegrityMetric(sourceintegrity, "sourceintegrity", errors);
    if (cleanup != null) validateScenarioMetric(cleanup, "cleanup", errors);

    if (typeof document.support !== "string" || !RepositorySupports.has(document.support as RepositorySupport)) {
        errors.push("support is invalid");
    }

    const hasFailure = Object.hasOwn(document, "failure");
    const failure = hasFailure ? document.failure : undefined;
    if (hasFailure) {
        if (!isRecord(failure)) {
            errors.push("failure must be an object");
        } else {
            if (typeof failure.code !== "string" || !FailureCodes.has(failure.code as ResultFailure["code"])) {
                errors.push("failure.code is invalid");
            }
            requireString(failure, "message", "failure.message", errors);
        }
    }

    const requiredEvidence = [cold, warm, undo, redo, exactbytes, gitintegrity, sourceintegrity, cleanup];
    const evidenceIsStructurallyValid = requiredEvidence.every((value) => value != null);
    if (evidenceIsStructurallyValid && RepositorySupports.has(document.support as RepositorySupport)) {
        const measuredSupport = classifyRepositorySupport(document as unknown as RepositorySupportEvidence);
        if (document.support !== measuredSupport) errors.push("support conflicts with repository evidence");
    }

    const hasFailedEvidence = requiredEvidence.some((value) => value?.status === "failed");
    if (hasFailedEvidence && failure == null) errors.push("failure is required for failed evidence");

    return { valid: errors.length === 0, errors };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === "object" && !Array.isArray(value);
}

function validateSerializationFields(value: unknown, errors: string[]): void {
    if (Array.isArray(value)) {
        value.forEach((child) => validateSerializationFields(child, errors));
        return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
        if (!/^[a-z]+$/.test(key)) errors.push(`field ${key} must be lowercase without underscores`);
        validateSerializationFields(child, errors);
    }
}

function requireRecord(
    parent: Record<string, unknown>,
    key: string,
    errors: string[],
    path = key
): Record<string, unknown> | undefined {
    const value = parent[key];
    if (!isRecord(value)) {
        errors.push(`${path} is required`);
        return undefined;
    }
    return value;
}

function requireString(parent: Record<string, unknown>, key: string, path: string, errors: string[]): void {
    if (typeof parent[key] !== "string" || parent[key].length === 0) errors.push(`${path} must be a non-empty string`);
}

function requireBoolean(parent: Record<string, unknown>, key: string, path: string, errors: string[]): void {
    if (typeof parent[key] !== "boolean") errors.push(`${path} must be a boolean`);
}

function requireNonnegativeNumber(parent: Record<string, unknown>, key: string, path: string, errors: string[]): void {
    const value = parent[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        errors.push(`${path} must be a non-negative finite number`);
    }
}

function validateStatus(parent: Record<string, unknown>, path: string, errors: string[]): void {
    if (typeof parent.status !== "string" || !ScenarioStatuses.has(parent.status as ScenarioStatus)) {
        errors.push(`${path}.status is invalid`);
    }
}

function validateScope(scope: Record<string, unknown>, path: string, errors: string[]): void {
    requireNonnegativeNumber(scope, "filecount", `${path}.filecount`, errors);
    requireNonnegativeNumber(scope, "bytecount", `${path}.bytecount`, errors);
}

function validateScenarioMetric(metric: Record<string, unknown>, path: string, errors: string[]): void {
    validateStatus(metric, path, errors);
    requireNonnegativeNumber(metric, "durationms", `${path}.durationms`, errors);
}

function validateCaptureMetric(metric: Record<string, unknown>, path: string, errors: string[]): void {
    validateScenarioMetric(metric, path, errors);
    validateScope(metric, path, errors);
    requireNonnegativeNumber(metric, "newbytes", `${path}.newbytes`, errors);
}

function validateIntegrityMetric(metric: Record<string, unknown>, path: string, errors: string[]): void {
    validateScenarioMetric(metric, path, errors);
    requireBoolean(metric, "clean", `${path}.clean`, errors);
}
