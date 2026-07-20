// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import type { Component } from "../../src/tui";
import type { ChartSeries, ChartType, WidgetChartNode } from "../widget-tree";

export interface ChartOptions {
    charttype: ChartType;
    series: ChartSeries[];
}

export class Chart implements Component {
    readonly widgetKind = "chart";
    readonly charttype: ChartType;
    readonly series: ChartSeries[];

    constructor(options: ChartOptions) {
        this.charttype = options.charttype;
        this.series = options.series;
    }

    toWidget(id: string): WidgetChartNode {
        return {
            kind: "chart",
            id,
            charttype: this.charttype,
            series: this.series,
        };
    }

    render(width: number): string[] {
        const max = Math.max(1, ...this.series.flatMap((series) => series.points.map((point) => point.value)));
        const lines: string[] = [];
        for (const series of this.series) {
            lines.push(series.name);
            for (const point of series.points) {
                const label = `${point.label} `;
                const barWidth = Math.max(1, width - label.length - 8);
                const filled = Math.max(1, Math.round((point.value / max) * barWidth));
                lines.push(`${label}${"#".repeat(filled)} ${point.value}`.slice(0, width));
            }
        }
        return lines;
    }

    invalidate(): void {}
}
