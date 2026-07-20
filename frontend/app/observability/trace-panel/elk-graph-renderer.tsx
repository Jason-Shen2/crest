// Copyright (c) 2023-2026 Langfuse GmbH
// SPDX-License-Identifier: MIT
// Ported from Langfuse web/src/features/trace-graph-view/components/ElkGraphRenderer.tsx.

import { select, type Selection } from "d3-selection";
import { zoom as createZoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from "d3-zoom";
import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { computeGraphLayout, type GraphLayout } from "./elk-layout";
import type { GraphCanvasData } from "./graph-types";
import { LangfuseEndNodeName, LangfuseStartNodeName } from "./graph-types";

type Transform = { x: number; y: number; k: number };

const FitPadding = 24;
const ZoomStep = 1.4;

function toPath(points: Array<{ x: number; y: number }>): string {
    return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function toCss(transform: Transform): string {
    return `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`;
}

export function ElkGraphRenderer({
    graph,
    selectedNodeId,
    onSelectNode,
}: {
    graph: GraphCanvasData;
    selectedNodeId: string | null;
    onSelectNode: (id: string | null) => void;
}) {
    const containerRef = useRef<HTMLDivElement>(null);
    const worldRef = useRef<HTMLDivElement>(null);
    const transformRef = useRef<Transform>({ x: 0, y: 0, k: 1 });
    const zoomRef = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(null);
    const selectionRef = useRef<Selection<HTMLDivElement, unknown, null, undefined> | null>(null);
    const [layout, setLayout] = useState<GraphLayout | null>(null);
    const [layoutError, setLayoutError] = useState(false);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const nodeMap = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);

    useEffect(() => {
        let cancelled = false;
        setLayout(null);
        setLayoutError(false);
        computeGraphLayout(graph)
            .then((result) => {
                if (!cancelled) {
                    setLayout(result);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setLayoutError(true);
                }
            });
        return () => {
            cancelled = true;
        };
    }, [graph]);

    useEffect(() => {
        const element = containerRef.current;
        if (!element) {
            return;
        }
        if (typeof ResizeObserver === "undefined") {
            setSize({ width: element.clientWidth, height: element.clientHeight });
            return;
        }
        const observer = new ResizeObserver(() => {
            setSize({ width: element.clientWidth, height: element.clientHeight });
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        const element = containerRef.current;
        if (!element) {
            return;
        }
        const selection = select(element);
        const zoom = createZoom<HTMLDivElement, unknown>()
            .scaleExtent([0.05, 2])
            .on("zoom", (event: D3ZoomEvent<HTMLDivElement, unknown>) => {
                transformRef.current = event.transform;
                if (worldRef.current) {
                    worldRef.current.style.transform = toCss(event.transform);
                }
            });
        selection.call(zoom);
        selection.on("dblclick.zoom", null);
        zoomRef.current = zoom;
        selectionRef.current = selection;
        return () => {
            selection.on(".zoom", null);
            zoomRef.current = null;
            selectionRef.current = null;
        };
    }, []);

    const applyTransform = useCallback((transform: Transform) => {
        if (!selectionRef.current || !zoomRef.current) {
            return;
        }
        zoomRef.current.transform(
            selectionRef.current,
            zoomIdentity.translate(transform.x, transform.y).scale(transform.k)
        );
    }, []);

    const fit = useCallback(() => {
        if (!layout || !layout.width || !layout.height || !size.width || !size.height) {
            return;
        }
        const k = Math.max(
            0.05,
            Math.min((size.width - FitPadding * 2) / layout.width, (size.height - FitPadding * 2) / layout.height, 1.2)
        );
        applyTransform({
            k,
            x: (size.width - layout.width * k) / 2,
            y: (size.height - layout.height * k) / 2,
        });
    }, [applyTransform, layout, size]);

    useEffect(() => {
        fit();
    }, [fit]);

    const zoomBy = (factor: number) => {
        if (selectionRef.current && zoomRef.current) {
            zoomRef.current.scaleBy(selectionRef.current, factor);
        }
    };
    const controls = [
        { label: "Zoom in", icon: ZoomIn, action: () => zoomBy(ZoomStep) },
        { label: "Zoom out", icon: ZoomOut, action: () => zoomBy(1 / ZoomStep) },
        { label: "Fit to view", icon: Maximize, action: fit },
    ];

    return (
        <div
            ref={containerRef}
            role="group"
            aria-label="Trace agent graph"
            className="relative h-full w-full cursor-grab overflow-hidden bg-fg-overlay-1/10 active:cursor-grabbing"
            onClick={() => onSelectNode(null)}
        >
            {!layout && !layoutError ? (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                    Laying out graph...
                </div>
            ) : null}
            {layoutError ? (
                <div className="absolute inset-0 flex items-center justify-center text-xs text-error">
                    Could not lay out the graph.
                </div>
            ) : null}
            {layout?.tooLarge ? (
                <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">
                    This graph is too large to lay out. Use the tree or timeline view.
                </div>
            ) : null}
            {layout && !layout.tooLarge ? (
                <div
                    ref={worldRef}
                    className="absolute top-0 left-0 origin-top-left"
                    style={{
                        width: layout.width,
                        height: layout.height,
                        transform: toCss(transformRef.current),
                    }}
                >
                    <svg
                        width={layout.width}
                        height={layout.height}
                        className="pointer-events-none absolute inset-0 overflow-visible"
                    >
                        <defs>
                            <marker
                                id="trace-graph-arrow"
                                markerWidth="8"
                                markerHeight="8"
                                refX="7"
                                refY="4"
                                orient="auto"
                            >
                                <path d="M0,0 L8,4 L0,8 Z" className="fill-muted-foreground/50" />
                            </marker>
                        </defs>
                        {layout.edges.map((edge) => (
                            <path
                                key={edge.id}
                                d={toPath(edge.points)}
                                className="fill-none stroke-muted-foreground/40"
                                strokeWidth={1.5}
                                markerEnd="url(#trace-graph-arrow)"
                            />
                        ))}
                    </svg>
                    {layout.nodes.map((node) => {
                        const metadata = nodeMap.get(node.id);
                        if (!metadata) {
                            return null;
                        }
                        const system = node.id === LangfuseStartNodeName || node.id === LangfuseEndNodeName;
                        return (
                            <button
                                key={node.id}
                                type="button"
                                aria-label={`${metadata.type} ${metadata.label}`}
                                aria-pressed={selectedNodeId === node.id}
                                className={`absolute flex cursor-pointer items-center justify-center truncate rounded-md border-2 px-2 text-xs font-medium shadow-sm ${
                                    system
                                        ? node.id === LangfuseStartNodeName
                                            ? "border-success bg-success text-white"
                                            : "border-error bg-error text-white"
                                        : selectedNodeId === node.id
                                          ? "border-accent bg-panel text-foreground ring-2 ring-accent/40"
                                          : "border-border bg-panel text-foreground hover:border-accent/60"
                                }`}
                                style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
                                title={metadata.label}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    if (!system) {
                                        onSelectNode(node.id);
                                    }
                                }}
                            >
                                {metadata.label.length > 28 ? `${metadata.label.slice(0, 27)}…` : metadata.label}
                            </button>
                        );
                    })}
                </div>
            ) : null}
            <div
                className="absolute top-2 right-2 z-10 flex flex-col gap-1"
                onClick={(event) => event.stopPropagation()}
            >
                {controls.map(({ label, icon: Icon, action }) => (
                    <button
                        key={label as string}
                        type="button"
                        title={label}
                        aria-label={label}
                        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded border border-border bg-panel/90 hover:bg-fg-overlay-1"
                        onClick={action}
                    >
                        <Icon className="h-3.5 w-3.5" />
                    </button>
                ))}
            </div>
        </div>
    );
}
