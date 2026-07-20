// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Box, Markdown, Spacer, Text, TruncatedText } from "@earendil-works/pi-tui";

const identity = (text) => text;

const markdownTheme = {
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

export default function registerMarkdownLayoutExample(pi) {
	pi.registerCommand("pi-official-markdown-layout", {
		description: "Official-style markdown and layout example",
		handler: async (_args, ctx) => {
			const root = new Box(2, 1);
			root.addChild(new Text("Markdown Layout Example", 0, 0));
			root.addChild(new Spacer(1));
			root.addChild(new Markdown("# Official Markdown Layout\n\n- visible markdown", 0, 0, markdownTheme));
			root.addChild(new TruncatedText("footer: ready", 0, 0));
			ctx.ui.setWidget("markdown-layout", root);
		},
	});
}
