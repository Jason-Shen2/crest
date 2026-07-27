// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CmdBlockInput, __testing } from "./cmdblock-input";

afterEach(cleanup);

describe("CmdBlockInput", () => {
    it("discovers /session and /info while keeping /resume hidden", () => {
        const byName = new Map(__testing.FallbackAgentSlashCommands.map((command) => [command.name, command]));

        expect(byName.get("/session")).toMatchObject({
            icon: "clock-rewind",
            description: expect.stringMatching(/manage|resume|reference/i),
        });
        expect(byName.get("/info")).toMatchObject({
            icon: "info-circle",
            description: expect.stringMatching(/current.*session.*information/i),
        });
        expect(byName.has("/resume")).toBe(false);
    });

    it("renders the compact terminal prompt as a themed shared icon aligned to the editor row", () => {
        const html = renderToStaticMarkup(
            <CmdBlockInput
                mode="terminal"
                onModeChange={() => undefined}
                onSubmit={() => undefined}
                hideHelpRow
                fontSize={16}
            />
        );

        expect(html).toContain('data-icon-name="chevron-right"');
        expect(html).toContain("text-current");
        expect(html).toContain("items-center");
        expect(html).not.toContain("--color-term-success");
        expect(html).not.toContain("text-secondary");
    });

    it("does not render context badges in terminal mode", () => {
        const html = renderToStaticMarkup(
            <CmdBlockInput
                mode="terminal"
                onModeChange={() => undefined}
                onSubmit={() => undefined}
                hideHelpRow
                branch="feature/no-terminal-badges"
                gitAdded={2372}
                gitRemoved={1171}
                prNumber={42}
                prTitle="Remove terminal badges"
                sshHost="devbox"
                sshUser="crest"
                kubernetesContext="prod-context"
            />
        );

        expect(html).not.toContain("feature/no-terminal-badges");
        expect(html).not.toContain("+2372");
        expect(html).not.toContain("-1171");
        expect(html).not.toContain("#42");
        expect(html).not.toContain("crest@devbox");
        expect(html).not.toContain("prod-context");
    });

    it("does not resync controlled editor text while IME composition is active", () => {
        const onTextChange = vi.fn();
        render(
            <CmdBlockInput
                mode="terminal"
                onModeChange={() => undefined}
                onSubmit={() => undefined}
                hideHelpRow
                onTextChange={onTextChange}
            />
        );
        const editor = screen.getByRole("textbox");

        fireEvent.compositionStart(editor);
        editor.textContent = "n";
        fireEvent.input(editor);
        expect(onTextChange).not.toHaveBeenCalled();

        editor.textContent = "你";
        fireEvent.compositionEnd(editor);
        expect(onTextChange).toHaveBeenLastCalledWith("你");
    });

    it("does not submit when Enter confirms an IME composition", () => {
        const onSubmit = vi.fn();
        render(
            <CmdBlockInput
                mode="terminal"
                onModeChange={() => undefined}
                onSubmit={onSubmit}
                hideHelpRow
            />
        );
        const editor = screen.getByRole("textbox");

        editor.textContent = "echo";
        fireEvent.input(editor);
        onSubmit.mockClear();

        fireEvent.compositionStart(editor);
        fireEvent.keyDown(editor, { key: "Enter" });

        expect(onSubmit).not.toHaveBeenCalled();
    });
});
