// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ExtensionAPI } from "../types";

export default function registerPiOfficialCustomUnsupportedExample(pi: ExtensionAPI): void {
	pi.registerCommand("pi-official-custom-unsupported", {
		description: "Certification fixture for unsupported custom official Pi TUI examples",
		handler: async (_args, ctx) => {
			await ctx.ui.custom(() => ({
				render: () => ["custom upstream tui surface"],
				invalidate: () => {},
			}));
		},
	});
}
