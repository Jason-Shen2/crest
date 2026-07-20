/**
 * Visual depth capping for deeply nested trees.
 *
 * Indentation is rendered per ancestor level with no natural bound, so an
 * extremely deep trace can push row content off the viewport.
 */

export interface VisualDepthConfig {
    indentPx: number;
    reservedPx: number;
    minDepth: number;
    maxDepth: number;
}

export const TreeVisualDepth: VisualDepthConfig = {
    indentPx: 20,
    reservedPx: 220,
    minDepth: 8,
    maxDepth: 32,
};

export function computeMaxVisualDepth(availableWidth: number, config: VisualDepthConfig): number {
    const { indentPx, reservedPx, minDepth, maxDepth } = config;
    if (availableWidth <= 0) {
        return maxDepth;
    }
    const byWidth = Math.floor((availableWidth - reservedPx) / indentPx);
    return Math.min(maxDepth, Math.max(minDepth, byWidth));
}
