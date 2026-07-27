import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { getFallbackFileBadgeLabel, LoadingTabLabel } from "./workspaceswitcher";

describe("workspace switcher display text", () => {
    it("uses ASCII-safe fallback text for labels that previously rendered as mojibake", () => {
        expect(getFallbackFileBadgeLabel("")).toBe("--");
        expect(LoadingTabLabel).toBe("...");
    });

    it("does not enumerate or mutate child Wave Tabs", () => {
        const source = fs.readFileSync(new URL("./workspaceswitcher.tsx", import.meta.url), "utf8");

        expect(source).not.toMatch(/\btabids\b/);
        expect(source).not.toMatch(/\bsetActiveTab\b/);
        expect(source).not.toMatch(/\bcloseTab\b/);
    });
});
