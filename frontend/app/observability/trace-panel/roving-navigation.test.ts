import { describe, expect, it } from "vitest";

import { getLinearNavigationAction, getTreeNavigationAction } from "./roving-navigation";

const rows = [
    { id: "root", depth: 0, children: [{}] },
    { id: "parent", depth: 1, children: [{}, {}] },
    { id: "first-child", depth: 2, children: [] },
    { id: "second-child", depth: 2, children: [] },
];

describe("getLinearNavigationAction", () => {
    it("moves to adjacent and boundary rows without wrapping", () => {
        expect(getLinearNavigationAction("ArrowDown", 1, 4)).toEqual({ type: "select", index: 2 });
        expect(getLinearNavigationAction("ArrowUp", 1, 4)).toEqual({ type: "select", index: 0 });
        expect(getLinearNavigationAction("Home", 2, 4)).toEqual({ type: "select", index: 0 });
        expect(getLinearNavigationAction("End", 1, 4)).toEqual({ type: "select", index: 3 });
        expect(getLinearNavigationAction("ArrowUp", 0, 4)).toBeNull();
        expect(getLinearNavigationAction("ArrowDown", 3, 4)).toBeNull();
        expect(getLinearNavigationAction("ArrowLeft", 1, 4)).toBeNull();
    });
});

describe("getTreeNavigationAction", () => {
    it("collapses expanded parents before moving to their parent", () => {
        expect(getTreeNavigationAction("ArrowLeft", 1, rows, new Set())).toEqual({
            type: "toggle",
            id: "parent",
        });
        expect(getTreeNavigationAction("ArrowLeft", 1, rows, new Set(["parent"]))).toEqual({
            type: "select",
            index: 0,
        });
        expect(getTreeNavigationAction("ArrowLeft", 2, rows, new Set())).toEqual({
            type: "select",
            index: 1,
        });
    });

    it("expands collapsed parents before moving to their first child", () => {
        expect(getTreeNavigationAction("ArrowRight", 1, rows, new Set(["parent"]))).toEqual({
            type: "toggle",
            id: "parent",
        });
        expect(getTreeNavigationAction("ArrowRight", 1, rows, new Set())).toEqual({
            type: "select",
            index: 2,
        });
        expect(getTreeNavigationAction("ArrowRight", 2, rows, new Set())).toBeNull();
    });

    it("preserves linear tree movement", () => {
        expect(getTreeNavigationAction("ArrowDown", 1, rows, new Set())).toEqual({
            type: "select",
            index: 2,
        });
        expect(getTreeNavigationAction("Home", 2, rows, new Set())).toEqual({
            type: "select",
            index: 0,
        });
    });
});
