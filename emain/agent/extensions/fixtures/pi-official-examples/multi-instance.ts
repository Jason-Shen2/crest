// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Box, SelectList, Text } from "@earendil-works/pi-tui";

const identity = (text) => text;

const selectTheme = {
	selectedPrefix: identity,
	selectedText: identity,
	description: identity,
	scrollInfo: identity,
	noMatch: identity,
};

export default function registerMultiInstanceExample(pi) {
	pi.registerCommand("pi-official-multi-instance", {
		description: "Official-style multi-instance targeting example",
		handler: async (_args, ctx) => {
			const root = new Box(0, 0);
			const firstStatus = new Text("First list: ready", 0, 0);
			const secondStatus = new Text("Second list: ready", 0, 0);
			const first = new SelectList(
				[
					{ value: "alpha", label: "Alpha", description: "first alpha" },
					{ value: "beta", label: "Beta", description: "first beta" },
				],
				2,
				selectTheme
			);
			const second = new SelectList(
				[
					{ value: "gamma", label: "Gamma", description: "second gamma" },
					{ value: "delta", label: "Delta", description: "second delta" },
				],
				2,
				selectTheme
			);
			first.onSelect = (item) => firstStatus.setText(`First selected: ${item.label}`);
			second.onSelect = (item) => secondStatus.setText(`Second selected: ${item.label}`);
			root.addChild(new Text("Multi Instance Example", 0, 0));
			root.addChild(firstStatus);
			root.addChild(first);
			root.addChild(secondStatus);
			root.addChild(second);
			ctx.ui.setWidget("multi-instance", root);
		},
	});
}
