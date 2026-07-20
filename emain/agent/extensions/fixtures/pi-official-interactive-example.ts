// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
	Box,
	CancellableLoader,
	Editor,
	Image,
	Input,
	Loader,
	SelectList,
	SettingsList,
	Text,
	type EditorTheme,
	type SelectListTheme,
	type SettingsListTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../types";

const identity = (text: string): string => text;

const selectTheme: SelectListTheme = {
	selectedPrefix: identity,
	selectedText: identity,
	description: identity,
	scrollInfo: identity,
	noMatch: identity,
};

const settingsTheme: SettingsListTheme = {
	label: identity,
	value: identity,
	description: identity,
	cursor: ">",
	hint: identity,
};

const editorTheme: EditorTheme = {
	borderColor: identity,
	selectList: selectTheme,
};

const tui = { requestRender: () => {} } as TUI;

export default function registerPiOfficialInteractiveExample(pi: ExtensionAPI): void {
	pi.registerCommand("pi-official-interactive", {
		description: "Certification fixture for interactive official Pi TUI examples",
		handler: async (_args, ctx) => {
			const root = new Box(0, 0);
			const select = new SelectList(
				[
					{ value: "alpha", label: "Alpha", description: "first" },
					{ value: "beta", label: "Beta", description: "second" },
				],
				5,
				selectTheme
			);
			const input = new Input();
			const settings = new SettingsList(
				[{ id: "mode", label: "Mode", currentValue: "gui", values: ["gui", "tui"] }],
				5,
				settingsTheme,
				() => {},
				() => {}
			);
			const editor = new Editor(tui, editorTheme, { paddingX: 1 });
			input.setValue("draft");
			editor.setText("edit me");
			root.addChild(new Text("Official Interactive Example", 0, 0));
			root.addChild(select);
			root.addChild(input);
			root.addChild(settings);
			root.addChild(editor);
			ctx.ui.setWidget("official-interactive", root);
			await ctx.ui.custom(() => new Loader(tui, identity, identity, "Loading", { frames: ["*"] }));
			await ctx.ui.custom(() => new CancellableLoader(tui, identity, identity, "Abortable", { frames: ["!"] }));
			await ctx.ui.custom(
				() =>
					new Image(
						"aGVsbG8=",
						"image/png",
						{ fallbackColor: identity },
						{ filename: "official.png" },
						{ widthPx: 12, heightPx: 8 }
					)
			);
		},
	});
}
