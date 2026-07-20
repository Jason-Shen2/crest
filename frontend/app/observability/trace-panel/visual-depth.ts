// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Source: https://github.com/langfuse/langfuse/blob/1cb1bbcf6b269fd887a6667796f1a15417cca336/web/src/components/trace/components/_shared/visual-depth.ts

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
