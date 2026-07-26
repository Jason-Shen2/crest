import { afterEach, describe, expect, it, vi } from "vitest";
import { recordTopTabPerformance, topTabPerformanceNow } from "./top-tab-performance";

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe("Top Tab performance tracing", () => {
    it.each(["top-tab-open", "top-tab-activate", "top-tab-first-content", "workspace-checkpoint-error"] as const)(
        "records the development-only %s mark with bounded metadata",
        (name) => {
            vi.stubEnv("DEV", true);
            const mark = vi.fn();
            vi.stubGlobal("performance", { mark });

            recordTopTabPerformance(name, {
                kind: name === "workspace-checkpoint-error" ? "workspace" : "file",
                id: "opaque-1",
                duration: 12.5,
            });

            expect(mark).toHaveBeenCalledWith(name, {
                detail: {
                    kind: name === "workspace-checkpoint-error" ? "workspace" : "file",
                    id: "opaque-1",
                    duration: 12.5,
                },
            });
            expect(JSON.stringify(mark.mock.calls)).not.toContain("/repo");
        }
    );

    it("does not record marks outside development", () => {
        vi.stubEnv("NODE_ENV", "production");
        const mark = vi.fn();
        vi.stubGlobal("performance", { mark });

        recordTopTabPerformance("top-tab-open", {
            kind: "file",
            id: "opaque-1",
            duration: 1,
        });

        expect(mark).not.toHaveBeenCalled();
    });

    it("returns a safe clock value when performance.now and Date.now throw", () => {
        vi.stubGlobal("performance", {
            now: () => {
                throw new Error("clock failed");
            },
        });
        const dateNow = vi.spyOn(Date, "now").mockImplementation(() => {
            throw new Error("date clock failed");
        });

        expect(() => topTabPerformanceNow()).not.toThrow();
        expect(topTabPerformanceNow()).toBe(0);
        dateNow.mockRestore();
    });

    it.each([
        ["throwing mark", new Error("mark failed")],
        ["unsupported mark options", new TypeError("options unsupported")],
    ])("contains %s without retrying or leaking metadata", (_name, failure) => {
        const mark = vi.fn(() => {
            throw failure;
        });
        vi.stubGlobal("performance", { mark });

        expect(() =>
            recordTopTabPerformance("top-tab-open", {
                kind: "file",
                id: "opaque-1",
                duration: 1,
            })
        ).not.toThrow();
        expect(mark).toHaveBeenCalledOnce();
        expect(JSON.stringify(mark.mock.calls)).not.toContain("/repo");
    });

    it("contains missing runtime globals during the development check", () => {
        vi.stubGlobal("process", undefined);
        vi.stubGlobal("performance", undefined);

        expect(() =>
            recordTopTabPerformance("top-tab-open", {
                kind: "file",
                id: "opaque-1",
                duration: 1,
            })
        ).not.toThrow();
    });
});
