/**
 * Tree flattening utilities for virtualized rendering.
 *
 * Converts hierarchical tree structure into flat list for virtualization,
 * while tracking depth, tree lines, and sibling relationships for visual rendering.
 */

export interface FlatNode<T> {
    node: T;
    depth: number;
    treeLines: boolean[];
    isLastSibling: boolean;
}

/**
 * Flattens tree into list for virtualized rendering using iterative approach.
 * Respects collapsed state - collapsed nodes don't include children.
 *
 * Uses an explicit stack instead of recursion to avoid stack overflow
 * with deeply nested trees (10k+ levels).
 */
export function flattenTree<T extends { id: string; children: T[]; startTime?: Date }>(
    roots: T[],
    collapsedNodes: Set<string>
): FlatNode<T>[] {
    if (roots.length === 0) {
        return [];
    }

    const flatList: FlatNode<T>[] = [];
    const sortedRoots = [...roots].sort((a, b) => {
        const aStart = a.startTime?.getTime() ?? 0;
        const bStart = b.startTime?.getTime() ?? 0;
        return aStart - bStart;
    });
    const stack: Array<{
        node: T;
        depth: number;
        treeLines: boolean[];
        isLastSibling: boolean;
    }> = [];

    for (let index = sortedRoots.length - 1; index >= 0; index -= 1) {
        stack.push({
            node: sortedRoots[index],
            depth: 0,
            treeLines: [],
            isLastSibling: index === sortedRoots.length - 1,
        });
    }

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {
            continue;
        }
        flatList.push({
            node: current.node,
            depth: current.depth,
            treeLines: current.treeLines,
            isLastSibling: current.isLastSibling,
        });

        if (current.node.children.length === 0 || collapsedNodes.has(current.node.id)) {
            continue;
        }

        const sortedChildren = [...current.node.children].sort((a, b) => {
            const aStart = a.startTime?.getTime() ?? 0;
            const bStart = b.startTime?.getTime() ?? 0;
            return aStart - bStart;
        });
        for (let index = sortedChildren.length - 1; index >= 0; index -= 1) {
            const child = sortedChildren[index];
            const isChildLast = index === sortedChildren.length - 1;
            stack.push({
                node: child,
                depth: current.depth + 1,
                treeLines: [...current.treeLines, !isChildLast],
                isLastSibling: isChildLast,
            });
        }
    }

    return flatList;
}
