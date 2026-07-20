// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Box, Markdown, Spacer, Text, TruncatedText, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "../types";

const identity = (text: string): string => text;

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

export default function registerPiOfficialBasicExample(pi: ExtensionAPI): void {
	pi.registerCommand("pi-official-basic", {
		description: "Certification fixture for static official Pi TUI examples",
		handler: async (_args, ctx) => {
			const root = new Box(1, 0);
			root.addChild(new Text("Official Basic Example", 0, 0));
			root.addChild(new Spacer(1));
			root.addChild(new TruncatedText("status: ready", 0, 0));
			ctx.ui.setWidget("official-basic", root);
			await ctx.ui.custom(() => new Markdown("# Official Markdown\n\n- certified", 0, 0, markdownTheme));
		},
	});
}
