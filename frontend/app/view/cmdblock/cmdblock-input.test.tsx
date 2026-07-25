// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CmdBlockInput, __testing } from "./cmdblock-input";

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
});
