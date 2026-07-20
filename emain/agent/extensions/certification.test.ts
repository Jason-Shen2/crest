// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	PiOfficialExampleFixtures,
	runPiOfficialExamplesCertification,
	type PiOfficialExampleCertificationReport,
} from "./certification";

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
			results: [
				expect.objectContaining({
					id: "select-input",
					status: "unsupported",
					command: "pi-official-select-input",
					componentKinds: ["box", "input", "selectlist", "text"],
					unsupportedReasons: expect.arrayContaining([
						expect.stringContaining("planned component certification blocker: Box"),
						expect.stringContaining("planned component certification blocker: Input"),
						expect.stringContaining("planned component certification blocker: SelectList"),
					]),
					errors: [],
				}),
				expect.objectContaining({
					id: "markdown-layout",
					status: "unsupported",
					command: "pi-official-markdown-layout",
					componentKinds: ["box", "markdown", "spacer", "text", "truncatedtext"],
					unsupportedReasons: expect.arrayContaining([
						expect.stringContaining("planned component certification blocker: Box"),
						expect.stringContaining("planned component certification blocker: Markdown"),
					]),
					errors: [],
				}),
				expect.objectContaining({
					id: "official-interactive",
					status: "unsupported",
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
					unsupportedReasons: expect.arrayContaining([
						expect.stringContaining("planned component certification blocker: Box"),
						expect.stringContaining("planned component certification blocker: Editor"),
						expect.stringContaining("planned component certification blocker: Input"),
						expect.stringContaining("planned component certification blocker: Loader"),
						expect.stringContaining("planned component certification blocker: SelectList"),
						expect.stringContaining("planned component certification blocker: SettingsList"),
					]),
					errors: [],
				}),
				expect.objectContaining({
					id: "official-custom-unsupported",
					status: "unsupported",
					command: "pi-official-custom-unsupported",
					componentKinds: ["terminal"],
					unsupportedReasons: ["terminal fallback widget requires M3 terminal surface certification"],
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
					unsupportedReasons: expect.arrayContaining([
						expect.stringContaining("planned component certification blocker: Box"),
						expect.stringContaining("planned component certification blocker: Editor"),
						expect.stringContaining("planned component certification blocker: Input"),
						expect.stringContaining("planned component certification blocker: Loader"),
						expect.stringContaining("planned component certification blocker: Markdown"),
						expect.stringContaining("planned component certification blocker: SelectList"),
						expect.stringContaining("planned component certification blocker: SettingsList"),
						"terminal fallback widget requires M3 terminal surface certification",
					]),
					errors: [],
				}),
			],
		});
	});
});
