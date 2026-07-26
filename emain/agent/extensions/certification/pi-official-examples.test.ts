// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	evaluateM21CBehaviorClosureGate,
	PiOfficialExampleFixtures,
	runPiOfficialExamplesCertification,
	type PiOfficialExampleFixture,
} from "../certification.ts";

const TerminalReason = "terminal fallback widget requires M3 terminal surface certification";
const RequiredFixtureIds = [
	"select-input",
	"markdown-layout",
	"official-interactive",
	"official-custom-unsupported",
	"pi-gui-showcase",
];

describe("Pi official examples certification", () => {
	it("uses complete Input fixture payloads for change and submit", () => {
		const fixtures = PiOfficialExampleFixtures.filter((fixture) =>
			["select-input", "pi-gui-showcase"].includes(fixture.id)
		);
		let inspectedEvents = 0;

		for (const fixture of fixtures) {
			let latestChange: Record<string, unknown> | undefined;
			for (const behavior of fixture.visibleBehaviors ?? []) {
				for (const event of behavior.events) {
					if (event.targetKind !== "input" || (event.type !== "change" && event.type !== "submit")) continue;
					const payload = event.payload as Record<string, unknown>;
					expect(payload).toEqual({
						value: expect.any(String),
						selectionstart: expect.any(Number),
						selectionend: expect.any(Number),
					});
					expect(Number.isInteger(payload.selectionstart)).toBe(true);
					expect(Number.isInteger(payload.selectionend)).toBe(true);
					expect(payload.selectionstart).toBeLessThanOrEqual(payload.selectionend as number);
					expect(payload.selectionend).toBeLessThanOrEqual((payload.value as string).length);
					if (event.type === "change") {
						latestChange = payload;
					} else {
						expect(payload).toEqual(latestChange);
					}
					inspectedEvents++;
				}
			}
		}

		expect(inspectedEvents).toBe(4);
	});

	it("certifies the five behavior-closed official examples and jiti-loaded rich semantic widgets", async () => {
		const report = await runPiOfficialExamplesCertification({
			cwd: process.cwd(),
			configHome: join(process.cwd(), ".tmp", "pi-official-examples-certification"),
		});
		const gate = evaluateM21CBehaviorClosureGate(report);

		expect(PiOfficialExampleFixtures.map((fixture) => fixture.id)).toEqual(RequiredFixtureIds);

		expect(report.status).toBe("failed");
		expect(report).toMatchObject({
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
		});
		expect(gate.gateStatus).toBe("passed");
		expect(report.results).toHaveLength(5);
		expect(new Set(report.results.map((result) => result.id))).toEqual(new Set(RequiredFixtureIds));

		const statusById = new Map(report.results.map((result) => [result.id, result.status]));
		expect(statusById.get("select-input")).toBe("passed");
		expect(statusById.get("markdown-layout")).toBe("passed");
		expect(statusById.get("official-interactive")).toBe("passed");
		expect(statusById.get("official-custom-unsupported")).toBe("unsupported");
		expect(statusById.get("pi-gui-showcase")).toBe("unsupported");

		for (const result of report.results) {
			if (result.status === "passed") {
				expect(result.unsupportedReasons).toEqual([]);
			}
			if (result.status === "unsupported") {
				expect(result.unsupportedReasons).toEqual([TerminalReason]);
			}
		}

		const selectInput = report.results.find((result) => result.id === "select-input");
		expect(selectInput).toMatchObject({
			status: "passed",
			componentKinds: ["box", "input", "selectlist", "text"],
			unsupportedReasons: [],
			visibleAssertions: [
				{ label: "visible text: Select Input Example", status: "passed", actualText: expect.stringContaining("Select Input Example") },
				{ label: "visible text: Interaction: ready", status: "passed", actualText: expect.stringContaining("Interaction: ready") },
				{ label: "visible text: draft", status: "passed", actualText: expect.stringContaining("draft") },
				{ label: "visible text: Alpha", status: "passed", actualText: expect.stringContaining("Alpha") },
				{ label: "visible text: Beta", status: "passed", actualText: expect.stringContaining("Beta") },
				{
					label: "selecting an item updates the visible status",
					status: "passed",
					actualText: expect.stringContaining("Selected: Beta"),
				},
				{
					label: "submitting edited input updates the visible status",
					status: "passed",
					actualText: expect.stringContaining("Submitted: final answer"),
				},
			],
			errors: [],
		});
		const submitAssertion = selectInput?.visibleAssertions.find(
			(assertion) => assertion.label === "submitting edited input updates the visible status"
		);
		expect(submitAssertion?.actualText).not.toContain("Selected: Beta");

		const markdownLayout = report.results.find((result) => result.id === "markdown-layout");
		expect(markdownLayout).toMatchObject({
			status: "passed",
			componentKinds: ["box", "markdown", "spacer", "text", "truncatedtext"],
			unsupportedReasons: [],
			visibleAssertions: [
				{ label: "visible text: Markdown Layout Example", status: "passed", actualText: expect.stringContaining("Markdown Layout Example") },
				{ label: "visible text: # Official Markdown Layout", status: "passed", actualText: expect.stringContaining("# Official Markdown Layout") },
				{ label: "visible text: footer: ready", status: "passed", actualText: expect.stringContaining("footer: ready") },
			],
			errors: [],
		});

		const interactive = report.results.find((result) => result.id === "official-interactive");
		expect(interactive).toMatchObject({
			status: "passed",
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
		});

		const custom = report.results.find((result) => result.id === "official-custom-unsupported");
		expect(custom).toMatchObject({
			status: "unsupported",
			componentKinds: ["terminal"],
			unsupportedReasons: [TerminalReason],
			visibleAssertions: [
				{
					label: "hidden text after close: custom upstream tui surface",
					status: "passed",
					actualText: expect.not.stringContaining("custom upstream tui surface"),
				},
			],
			errors: [],
		});

		const showcase = report.results.find((result) => result.id === "pi-gui-showcase");
		expect(showcase?.componentKinds.filter((kind) => ["richtable", "diffview", "chart"].includes(kind))).toEqual([
			"chart",
			"diffview",
			"richtable",
		]);
		expect(showcase).toMatchObject({
			status: "unsupported",
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
			visibleAssertions: expect.arrayContaining([
				expect.objectContaining({ label: "visible text: Pi GUI Showcase", status: "passed" }),
				expect.objectContaining({
					label: "selecting showcase item records a visible selected result",
					status: "passed",
					actualText: expect.stringContaining("Selected: Input"),
				}),
				expect.objectContaining({
					label: "submitting showcase input records a visible submitted result",
					status: "passed",
					actualText: expect.stringContaining("Submitted: certified value"),
				}),
				expect.objectContaining({
					label: "cancelling showcase input records a visible cancelled result",
					status: "passed",
					actualText: expect.stringContaining("Cancelled"),
				}),
			]),
			errors: [],
		});
	});

	it("targets multi-instance behavior by stable label instead of latest target kind", async () => {
		const fixture: PiOfficialExampleFixture = {
			id: "multi-instance",
			label: "Multi-instance official example",
			path: join(process.cwd(), "emain/agent/extensions/fixtures/pi-official-examples/multi-instance.ts"),
			command: "pi-official-multi-instance",
			expectedComponentKinds: ["box", "selectlist", "text"],
			expectedVisibleText: ["Multi Instance Example", "First list: ready", "Second list: ready", "Alpha", "Gamma"],
			visibleBehaviors: [
				{
					label: "selecting second list by stable label does not hit the first list",
					events: [{ targetKind: "selectlist", targetLabel: "Gamma", type: "select", payload: { index: 1 } }],
					expectedText: "Second selected: Delta",
					unexpectedText: "First selected: Beta",
				},
			],
		};
		const report = await runPiOfficialExamplesCertification({
			cwd: process.cwd(),
			configHome: join(process.cwd(), ".tmp", "pi-official-multi-instance-certification"),
			fixtures: [fixture],
		});

		const result = report.results[0];
		expect(result.status).toBe("passed");
		expect(result.errors).toEqual([]);
		expect(result.unsupportedReasons).toEqual([]);
		expect(result.visibleAssertions).toContainEqual(
			expect.objectContaining({
				label: "selecting second list by stable label does not hit the first list",
				status: "passed",
				actualText: expect.stringContaining("Second selected: Delta"),
			})
		);
	});
});
