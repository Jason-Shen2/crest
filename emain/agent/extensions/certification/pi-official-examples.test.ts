// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runPiOfficialExamplesCertification, type PiOfficialExampleFixture } from "../certification.ts";

describe("Pi official examples certification", () => {
	it("certifies planned official examples with source-compatible fixtures and visible behavior assertions", async () => {
		const report = await runPiOfficialExamplesCertification({
			cwd: process.cwd(),
			configHome: join(process.cwd(), ".tmp", "pi-official-examples-certification"),
		});

		expect(report.status).toBe("failed");
		expect(report).toMatchObject({
			total: 5,
			passed: 0,
			unsupported: 5,
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
		expect(report.results.map((result) => result.id)).toEqual([
			"select-input",
			"markdown-layout",
			"official-interactive",
			"official-custom-unsupported",
			"pi-gui-showcase",
		]);

		const selectInput = report.results.find((result) => result.id === "select-input");
		expect(selectInput).toMatchObject({
			status: "unsupported",
			componentKinds: ["box", "input", "selectlist", "text"],
			unsupportedReasons: expect.arrayContaining([
				expect.stringContaining("planned component certification blocker: Box"),
				expect.stringContaining("planned component certification blocker: SelectList"),
				expect.stringContaining("planned component certification blocker: Input"),
			]),
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
			status: "unsupported",
			componentKinds: ["box", "markdown", "spacer", "text", "truncatedtext"],
			unsupportedReasons: expect.arrayContaining([
				expect.stringContaining("planned component certification blocker: Box"),
				expect.stringContaining("planned component certification blocker: Markdown"),
			]),
			visibleAssertions: [
				{ label: "visible text: Markdown Layout Example", status: "passed", actualText: expect.stringContaining("Markdown Layout Example") },
				{ label: "visible text: # Official Markdown Layout", status: "passed", actualText: expect.stringContaining("# Official Markdown Layout") },
				{ label: "visible text: footer: ready", status: "passed", actualText: expect.stringContaining("footer: ready") },
			],
			errors: [],
		});

		const interactive = report.results.find((result) => result.id === "official-interactive");
		expect(interactive).toMatchObject({
			status: "unsupported",
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
			unsupportedReasons: expect.arrayContaining([
				expect.stringContaining("planned component certification blocker: Box"),
				expect.stringContaining("planned component certification blocker: Editor"),
				expect.stringContaining("planned component certification blocker: Input"),
				expect.stringContaining("planned component certification blocker: Loader"),
				expect.stringContaining("planned component certification blocker: SelectList"),
				expect.stringContaining("planned component certification blocker: SettingsList"),
			]),
			errors: [],
		});

		const custom = report.results.find((result) => result.id === "official-custom-unsupported");
		expect(custom).toMatchObject({
			status: "unsupported",
			componentKinds: ["terminal"],
			unsupportedReasons: ["terminal fallback widget requires M3 terminal surface certification"],
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
		expect(result.status).toBe("unsupported");
		expect(result.errors).toEqual([]);
		expect(result.visibleAssertions).toContainEqual(
			expect.objectContaining({
				label: "selecting second list by stable label does not hit the first list",
				status: "passed",
				actualText: expect.stringContaining("Second selected: Delta"),
			})
		);
	});
});
