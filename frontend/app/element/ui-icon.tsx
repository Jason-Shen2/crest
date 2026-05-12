// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { cn } from "@/util/util";
import { memo } from "react";

const rawIcons = import.meta.glob("../asset/ui-icons/*.svg", {
    eager: true,
    query: "?raw",
    import: "default",
}) as unknown as Record<string, string>;

const iconMap: Record<string, string> = {};
for (const [path, source] of Object.entries(rawIcons)) {
    const name = path.split("/").pop()!.replace(/\.svg$/, "");
    iconMap[name] = source;
}

export type UIconName = keyof typeof iconMap | string;

interface UIconProps {
    name: string;
    className?: string;
    size?: number | string;
    title?: string;
    style?: React.CSSProperties;
}

export const UIcon = memo(({ name, className, size, title, style }: UIconProps) => {
    const source = iconMap[name];
    if (!source) {
        return <span className={cn("inline-block", className)} aria-label={`missing icon: ${name}`} />;
    }
    const dim = size ?? "1em";
    return (
        <span
            className={cn(
                "inline-flex items-center justify-center shrink-0",
                "[&>svg]:block [&>svg]:h-full [&>svg]:w-full",
                className
            )}
            style={{ width: dim, height: dim, lineHeight: 0, ...style }}
            role={title ? "img" : "presentation"}
            aria-label={title}
            dangerouslySetInnerHTML={{ __html: source }}
        />
    );
});
UIcon.displayName = "UIcon";
