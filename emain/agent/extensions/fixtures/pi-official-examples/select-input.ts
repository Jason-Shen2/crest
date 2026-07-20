// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Box, Input, SelectList, Text } from "@earendil-works/pi-tui";

const identity = (text) => text;

const selectTheme = {
	selectedPrefix: identity,
	selectedText: identity,
	description: identity,
	scrollInfo: identity,
	noMatch: identity,
};

export default function registerSelectInputExample(pi) {
	pi.registerCommand("pi-official-select-input", {
		description: "Official-style select and input example",
		handler: async (_args, ctx) => {
			const root = new Box(1, 0);
			const status = new Text("Interaction: ready", 0, 0);
			const select = new SelectList(
				[
					{ value: "alpha", label: "Alpha", description: "first option" },
					{ value: "beta", label: "Beta", description: "second option" },
				],
				4,
				selectTheme
			);
			const input = new Input();
			input.setValue("draft");
			select.onSelect = (item) => status.setText(`Selected: ${item.label}`);
			input.onSubmit = (value) => status.setText(`Submitted: ${value}`);
			input.onEscape = () => status.setText("Cancelled");
			root.addChild(new Text("Select Input Example", 0, 0));
			root.addChild(status);
			root.addChild(select);
			root.addChild(input);
			ctx.ui.setWidget("select-input", root);
		},
	});
}
