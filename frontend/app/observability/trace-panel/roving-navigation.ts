export type RovingNavigationAction = { type: "select"; index: number } | { type: "toggle"; id: string };

export type RovingTreeRow = {
    id: string;
    depth: number;
    children: unknown[];
};

export function getLinearNavigationAction(key: string, index: number, rowCount: number): RovingNavigationAction | null {
    let nextIndex: number;
    if (key === "ArrowDown") {
        nextIndex = index + 1;
    } else if (key === "ArrowUp") {
        nextIndex = index - 1;
    } else if (key === "Home") {
        nextIndex = 0;
    } else if (key === "End") {
        nextIndex = rowCount - 1;
    } else {
        return null;
    }
    if (nextIndex < 0 || nextIndex >= rowCount || nextIndex === index) {
        return null;
    }
    return { type: "select", index: nextIndex };
}

function findParentIndex(rows: RovingTreeRow[], index: number): number | null {
    const depth = rows[index]?.depth;
    if (depth == null || depth === 0) {
        return null;
    }
    for (let parentIndex = index - 1; parentIndex >= 0; parentIndex -= 1) {
        if (rows[parentIndex].depth < depth) {
            return parentIndex;
        }
    }
    return null;
}

export function getTreeNavigationAction(
    key: string,
    index: number,
    rows: RovingTreeRow[],
    collapsedNodes: Set<string>
): RovingNavigationAction | null {
    const linearAction = getLinearNavigationAction(key, index, rows.length);
    if (linearAction != null) {
        return linearAction;
    }

    const row = rows[index];
    if (row == null) {
        return null;
    }
    if (key === "ArrowLeft") {
        if (row.children.length > 0 && !collapsedNodes.has(row.id)) {
            return { type: "toggle", id: row.id };
        }
        const parentIndex = findParentIndex(rows, index);
        return parentIndex == null ? null : { type: "select", index: parentIndex };
    }
    if (key === "ArrowRight" && row.children.length > 0) {
        if (collapsedNodes.has(row.id)) {
            return { type: "toggle", id: row.id };
        }
        if (rows[index + 1]?.depth > row.depth) {
            return { type: "select", index: index + 1 };
        }
    }
    return null;
}
