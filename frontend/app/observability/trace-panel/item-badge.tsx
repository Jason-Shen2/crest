import { Circle, GitBranch, Sparkles, Wrench } from "lucide-react";

import { cn } from "@/util/util";
import type { TraceNode } from "./types";

export function ItemBadge({
    type,
    isSmall,
    className,
}: {
    type: TraceNode["type"];
    isSmall?: boolean;
    className?: string;
}) {
    const size = isSmall ? "h-3 w-3" : "h-4 w-4";
    if (type === "TRACE" || type === "AGENT") {
        return <GitBranch className={cn(size, "text-accent", className)} />;
    }
    if (type === "GENERATION") {
        return <Sparkles className={cn(size, "text-accent", className)} />;
    }
    if (type === "TOOL") {
        return <Wrench className={cn(size, "text-success", className)} />;
    }
    return <Circle className={cn(isSmall ? "h-2.5 w-2.5" : "h-3 w-3", "text-muted-foreground", className)} />;
}
