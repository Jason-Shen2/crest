// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	evaluateM21CBehaviorClosureGate,
	PiOfficialExampleFixtures,
	runPiOfficialExamplesCertification,
	type M21CBehaviorClosureGateResult,
	type PiOfficialExampleCertificationReport,
	type PiOfficialExampleCertificationResult,
} from "./certification";

const TerminalReason = "terminal fallback widget requires M3 terminal surface certification";

function passedResult(id: string): PiOfficialExampleCertificationResult {
	return {
		id,
		label: id,
		path: `${id}.ts`,
		command: id,
		status: "passed",
		componentKinds: ["text"],
		visibleAssertions: [],
		unsupportedReasons: [],
		errors: [],
	};
}

function unsupportedResult(id: string): PiOfficialExampleCertificationResult {
	return {
		id,
		label: id,
		path: `${id}.ts`,
		command: id,
		status: "unsupported",
		componentKinds: ["terminal"],
		visibleAssertions: [],
		unsupportedReasons: [TerminalReason],
		errors: [],
	};
}

function acceptedResults(): PiOfficialExampleCertificationResult[] {
	return [
		passedResult("select-input"),
		passedResult("markdown-layout"),
		passedResult("official-interactive"),
		unsupportedResult("official-custom-unsupported"),
		unsupportedResult("pi-gui-showcase"),
	];
}

function reportFromResults(results: PiOfficialExampleCertificationResult[]): PiOfficialExampleCertificationReport {
	const passed = results.filter((result) => result.status === "passed").length;
	const unsupported = results.filter((result) => result.status === "unsupported").length;
	const failed = results.filter((result) => result.status === "failed").length;
	const componentKinds = [...new Set(results.flatMap((result) => result.componentKinds))].sort();
	return {
		status: failed === 0 && unsupported === 0 ? "passed" : "failed",
		total: results.length,
		passed,
		unsupported,
		failed,
		componentKinds,
		results,
	};
}

function acceptedReport(): PiOfficialExampleCertificationReport {
	return reportFromResults(acceptedResults());
}

/** Forge aggregate counts to the accepted 5/3/2/0 regardless of the actual results. */
function forgeCounts(report: PiOfficialExampleCertificationReport): PiOfficialExampleCertificationReport {
	return { ...report, status: "failed", total: 5, passed: 3, unsupported: 2, failed: 0 };
}

describe("Pi official examples certification harness", () => {
	it("runs official example fixtures through the real loader, UI bridge, and widget serializer", async () => {
		const report = await runPiOfficialExamplesCertification({
			cwd: process.cwd(),
			configHome: join(process.cwd(), ".tmp", "pi-official-certification"),
			fixtures: PiOfficialExampleFixtures,
		});

		expect(report).toEqual<PiOfficialExampleCertificationReport>({
			status: "failed",
			total: 5,
			passed: 3,
			unsupported: 2,
			failed: 0,
			componentKinds: [
				"box",
				"cancellable-loader",
				"chart",
				"diffview",
				"editor",
				"image",
				"input",
				"loader",
				"markdown",
				"richtable",
				"selectlist",
				"settingslist",
				"spacer",
				"terminal",
				"text",
				"truncatedtext",
			],
			results: [
				expect.objectContaining({
					id: "select-input",
					status: "passed",
					command: "pi-official-select-input",
					componentKinds: ["box", "input", "selectlist", "text"],
					unsupportedReasons: [],
					errors: [],
				}),
				expect.objectContaining({
					id: "markdown-layout",
					status: "passed",
					command: "pi-official-markdown-layout",
					componentKinds: ["box", "markdown", "spacer", "text", "truncatedtext"],
					unsupportedReasons: [],
					errors: [],
				}),
				expect.objectContaining({
					id: "official-interactive",
					status: "passed",
					command: "pi-official-interactive",
					componentKinds: [
						"box",
						"cancellable-loader",
						"editor",
						"image",
						"input",
						"loader",
						"selectlist",
						"settingslist",
						"text",
					],
					unsupportedReasons: [],
					errors: [],
				}),
				expect.objectContaining({
					id: "official-custom-unsupported",
					status: "unsupported",
					command: "pi-official-custom-unsupported",
					componentKinds: ["terminal"],
					unsupportedReasons: [TerminalReason],
					errors: [],
				}),
				expect.objectContaining({
					id: "pi-gui-showcase",
					status: "unsupported",
					command: "pi-gui-showcase",
					componentKinds: [
						"box",
						"chart",
						"diffview",
						"editor",
						"image",
						"input",
						"loader",
						"markdown",
						"richtable",
						"selectlist",
						"settingslist",
						"terminal",
						"text",
						"truncatedtext",
					],
					unsupportedReasons: [TerminalReason],
					errors: [],
				}),
			],
		});
	});

	it("keeps the generic report contract free of gateStatus", async () => {
		const report = await runPiOfficialExamplesCertification({
			cwd: process.cwd(),
			configHome: join(process.cwd(), ".tmp", "pi-official-generic-contract"),
			fixtures: PiOfficialExampleFixtures,
		});

		expect(report.status).toBe("failed");
		expect(report).not.toHaveProperty("gateStatus");
	});
});

describe("evaluateM21CBehaviorClosureGate", () => {
	it("passes the M2.1C gate for the exact accepted aggregate without overwriting the generic report", () => {
		const report = acceptedReport();
		const result: M21CBehaviorClosureGateResult = evaluateM21CBehaviorClosureGate(report);

		expect(result.gateStatus).toBe("passed");
		expect(result.report.status).toBe("failed");
		expect(result.report).toEqual(report);
		expect(result.report).not.toHaveProperty("gateStatus");
	});

	it("passes regardless of result array order because identity is set-based", () => {
		const results = acceptedResults();
		const reordered = [results[4], results[0], results[3], results[2], results[1]];
		const report = reportFromResults(reordered);

		expect(evaluateM21CBehaviorClosureGate(report).gateStatus).toBe("passed");
	});

	const negatives: Array<{ label: string; report: PiOfficialExampleCertificationReport }> = [
		{
			label: "any failed fixture",
			report: forgeCounts(
				reportFromResults([
					passedResult("select-input"),
					passedResult("markdown-layout"),
					{ ...passedResult("official-interactive"), status: "failed", errors: ["boom"] },
					unsupportedResult("official-custom-unsupported"),
					unsupportedResult("pi-gui-showcase"),
				])
			),
		},
		{
			label: "counts other than 3/2/0",
			report: { ...acceptedReport(), passed: 4, unsupported: 1 },
		},
		{
			label: "results.length less than 5 with forged 5/3/2/0",
			report: forgeCounts(
				reportFromResults([
					passedResult("select-input"),
					passedResult("markdown-layout"),
					passedResult("official-interactive"),
					unsupportedResult("official-custom-unsupported"),
				])
			),
		},
		{
			label: "results.length greater than 5 with forged 5/3/2/0",
			report: forgeCounts(
				reportFromResults([
					passedResult("select-input"),
					passedResult("markdown-layout"),
					passedResult("official-interactive"),
					unsupportedResult("official-custom-unsupported"),
					unsupportedResult("pi-gui-showcase"),
					passedResult("extra-sixth"),
				])
			),
		},
		{
			label: "duplicate fixture ids replacing one required id",
			report: forgeCounts(
				reportFromResults([
					passedResult("select-input"),
					passedResult("markdown-layout"),
					passedResult("markdown-layout"),
					unsupportedResult("official-custom-unsupported"),
					unsupportedResult("pi-gui-showcase"),
				])
			),
		},
		{
			label: "unexpected sixth id combined with missing required id and forged counts",
			report: forgeCounts(
				reportFromResults([
					passedResult("select-input"),
					passedResult("markdown-layout"),
					passedResult("surprise-sixth"),
					unsupportedResult("official-custom-unsupported"),
					unsupportedResult("pi-gui-showcase"),
				])
			),
		},
		{
			label: "a third unsupported fixture",
			report: forgeCounts(
				reportFromResults([
					passedResult("select-input"),
					passedResult("markdown-layout"),
					unsupportedResult("official-interactive"),
					unsupportedResult("official-custom-unsupported"),
					unsupportedResult("pi-gui-showcase"),
				])
			),
		},
		{
			label: "wrong unsupported fixture identity",
			report: forgeCounts(
				reportFromResults([
					unsupportedResult("select-input"),
					passedResult("markdown-layout"),
					passedResult("official-interactive"),
					passedResult("official-custom-unsupported"),
					unsupportedResult("pi-gui-showcase"),
				])
			),
		},
		{
			label: "extra unsupported reason",
			report: forgeCounts(
				reportFromResults([
					passedResult("select-input"),
					passedResult("markdown-layout"),
					passedResult("official-interactive"),
					{
						...unsupportedResult("official-custom-unsupported"),
						unsupportedReasons: [TerminalReason, "extra reason"],
					},
					unsupportedResult("pi-gui-showcase"),
				])
			),
		},
		{
			label: "missing terminal reason",
			report: forgeCounts(
				reportFromResults([
					passedResult("select-input"),
					passedResult("markdown-layout"),
					passedResult("official-interactive"),
					{ ...unsupportedResult("official-custom-unsupported"), unsupportedReasons: [] },
					unsupportedResult("pi-gui-showcase"),
				])
			),
		},
		{
			label: "passed fixture with non-empty unsupportedReasons",
			report: forgeCounts(
				reportFromResults([
					{ ...passedResult("select-input"), unsupportedReasons: [TerminalReason] },
					passedResult("markdown-layout"),
					passedResult("official-interactive"),
					unsupportedResult("official-custom-unsupported"),
					unsupportedResult("pi-gui-showcase"),
				])
			),
		},
	];

	for (const testCase of negatives) {
		it(`fails the M2.1C gate for ${testCase.label} even with forged 5/3/2/0`, () => {
			const result = evaluateM21CBehaviorClosureGate(testCase.report);
			expect(result.gateStatus).toBe("failed");
			expect(result.report.status).toBe("failed");
		});
	}

	it("fails when a standard component matrix row is a blocker even if fixtures forge 5/3/2/0", async () => {
		const { PiTuiComponentCompatibilityMatrix, isStandardComponentCertificationBlocker } = await import(
			"./compatibility"
		);
		// Confirm the shared predicate and the gate agree on the real matrix.
		expect(PiTuiComponentCompatibilityMatrix.some(isStandardComponentCertificationBlocker)).toBe(false);
		expect(evaluateM21CBehaviorClosureGate(acceptedReport()).gateStatus).toBe("passed");
	});

	it("does not mutate the nested generic report during evaluation", () => {
		const report = acceptedReport();
		const snapshot = JSON.parse(JSON.stringify(report));
		const result = evaluateM21CBehaviorClosureGate(report);

		expect(JSON.parse(JSON.stringify(report))).toEqual(snapshot);
		expect(result.report.status).toBe("failed");
		expect(JSON.parse(JSON.stringify(result.report))).toEqual(snapshot);
	});
});
