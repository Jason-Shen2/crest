// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsModal } from "./settings";

vi.mock("./sections/AboutSection", () => ({ AboutSection: () => <div>About content</div> }));
vi.mock("./sections/AgentsSection", () => ({ AgentsSection: () => <div>Agents content</div> }));
vi.mock("./sections/GeneralSection", () => ({ GeneralSection: () => <div>General content</div> }));
vi.mock("./sections/ModelsSection", () => ({ ModelsSection: () => <div>Models content</div> }));
vi.mock("./sections/ShortcutsSection", () => ({ ShortcutsSection: () => <div>Shortcuts content</div> }));
vi.mock("./sections/ThemesSection", () => ({ ThemesSection: () => <div>Themes content</div> }));

beforeEach(() => {
    const main = document.createElement("div");
    main.id = "main";
    document.body.appendChild(main);
});

afterEach(() => {
    cleanup();
    document.getElementById("main")?.remove();
});

describe("SettingsModal", () => {
    it("opens General by default", () => {
        render(<SettingsModal />);

        expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
        expect(screen.getByText("General content")).toBeTruthy();
    });

    it("opens the requested initial tab", () => {
        render(<SettingsModal initialTab="models" />);

        expect(screen.getByRole("tab", { name: "Models" }).getAttribute("aria-selected")).toBe("true");
        expect(screen.getByText("Models content")).toBeTruthy();
    });
});
