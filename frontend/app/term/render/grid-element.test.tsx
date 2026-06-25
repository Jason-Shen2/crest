// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DefaultStyle } from "../engine/types";
import { GridElement } from "./grid-element";

vi.mock("./cell-run", () => ({
    CellRun: () => <span data-testid="cell-run" />,
}));

const EmptyCell = {
    char: "",
    width: 1,
    style: DefaultStyle,
};

describe("GridElement", () => {
    it("does not crash when a rendered row is sparse", () => {
        const sparseRow = [] as any[];
        sparseRow[2] = {
            char: "a",
            width: 1,
            style: DefaultStyle,
        };
        sparseRow[3] = EmptyCell;
        const grid = {
            rowCount: () => 1,
            getRow: () => sparseRow,
            getRowVersion: () => 1,
            getLink: () => undefined,
        };

        expect(() =>
            renderToStaticMarkup(<GridElement source={grid as any} revision={1} />)
        ).not.toThrow();
    });
});
