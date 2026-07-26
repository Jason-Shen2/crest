// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { ExtensionAPI } from "../types";
import { Chart, DiffView, RichTable } from "@earendil-works/pi-tui";
import { Box } from "../pi-gui/src/components/box";
import { Editor, type EditorTheme } from "../pi-gui/src/components/editor";
import { Image } from "../pi-gui/src/components/image";
import { Input } from "../pi-gui/src/components/input";
import { Loader } from "../pi-gui/src/components/loader";
import { Markdown, type MarkdownTheme } from "../pi-gui/src/components/markdown";
import { SelectList, type SelectListTheme } from "../pi-gui/src/components/select-list";
import { SettingsList, type SettingsListTheme } from "../pi-gui/src/components/settings-list";
import { Text } from "../pi-gui/src/components/text";
import { TruncatedText } from "../pi-gui/src/components/truncated-text";
import type { TUI } from "../pi-gui/src/tui";

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

const markdownTheme: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

const editorTheme: EditorTheme = {
	borderColor: identity,
	selectList: selectTheme,
};

const tui = { requestRender: () => {} } as unknown as TUI;

export function registerPiGuiShowcaseExtension(pi: ExtensionAPI): void {
	pi.registerCommand("pi-gui-showcase", {
		description: "Showcase Pi TUI components rendered as Crest GUI widgets",
		handler: async (_args, ctx) => {
			const nested = new Box(1, 1);
			const interactionStatus = new Text("Interaction: ready", 0, 0);
			const nestedSelect = new SelectList(
				[
					{ value: "text", label: "Text", description: "basic text" },
					{ value: "input", label: "Input", description: "interactive input" },
				],
				4,
				selectTheme
			);
			const nestedInput = new Input();
			nestedSelect.onSelect = (item) => interactionStatus.setText(`Selected: ${item.label}`);
			nestedSelect.onCancel = () => interactionStatus.setText("Cancelled");
			nestedInput.setValue("editable");
			nestedInput.onSubmit = (value) => interactionStatus.setText(`Submitted: ${value}`);
			nestedInput.onEscape = () => interactionStatus.setText("Cancelled");
			nested.addChild(new Text("Nested Box", 0, 0));
			nested.addChild(interactionStatus);
			nested.addChild(nestedSelect);
			nested.addChild(nestedInput);

			const editor = new Editor(tui, editorTheme, { paddingX: 1 });
			editor.setText("edit me");

			ctx.ui.setWidget("nested", nested);
			ctx.ui.setHeader(new Text("Pi GUI Showcase", 0, 0));
			ctx.ui.setFooter(new TruncatedText("Pi GUI Showcase Footer", 1, 0));

			await ctx.ui.custom(() => new Markdown("# Markdown\n\n- rendered as GUI", 0, 0, markdownTheme));
			await ctx.ui.custom(
				() =>
					new SettingsList(
						[
							{
								id: "mode",
								label: "Mode",
								currentValue: "GUI",
								description: "SettingsList demo",
								values: ["GUI", "TUI"],
							},
						],
						4,
						settingsTheme,
						() => {},
						() => {}
					)
			);
			await ctx.ui.custom(() => editor);
			await ctx.ui.custom(
				() =>
					new Image(
						"aGVsbG8=",
						"image/png",
						{ fallbackColor: identity },
						{ filename: "showcase.png" },
						{ widthPx: 16, heightPx: 16 }
					)
			);
			await ctx.ui.custom(() => new Loader(tui, identity, identity, "Loading showcase", { frames: ["*"] }));
			await ctx.ui.custom(
				() =>
					new RichTable({
						columns: [
							{ key: "component", label: "Component" },
							{ key: "status", label: "Status" },
						],
						rows: [{ component: "RichTable", status: "GUI" }],
						selectedrow: 0,
					})
			);
			await ctx.ui.custom(
				() =>
					new DiffView({
						filename: "showcase.ts",
						hunks: [{ header: "@@ -1 +1 @@", lines: [{ type: "add", text: "+gui" }] }],
					})
			);
			await ctx.ui.custom(
				() =>
					new Chart({
						charttype: "bar",
						series: [{ name: "coverage", points: [{ label: "GUI", value: 13 }] }],
					})
			);
			await ctx.ui.custom(() => ({
				render: () => ["terminal fallback"],
				invalidate: () => {},
			}));
		},
	});

	pi.registerMessageRenderer("pi-gui-showcase-message", (data: { label?: string }) => {
		return new Text(`showcase message:${data.label ?? "demo"}`, 0, 0);
	});

	pi.registerEntryRenderer("pi-gui-showcase-entry", (data: { label?: string }) => {
		return new Text(`showcase entry:${data.label ?? "demo"}`, 0, 0);
	});
}

export default registerPiGuiShowcaseExtension;
