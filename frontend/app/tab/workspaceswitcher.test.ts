import { describe, expect, it } from "vitest";
import { getFallbackFileBadgeLabel, LoadingTabLabel } from "./workspaceswitcher";

describe("workspace switcher display text", () => {
    it("uses ASCII-safe fallback text for labels that previously rendered as mojibake", () => {
        expect(getFallbackFileBadgeLabel("")).toBe("--");
        expect(LoadingTabLabel).toBe("...");
    });
});