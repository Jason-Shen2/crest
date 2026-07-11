// Based on assistant-ui (MIT): https://r.assistant-ui.com/tooltip-icon-button.json
"use client";

import { type ComponentPropsWithRef, forwardRef } from "react";
import { Slot } from "radix-ui";

import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/shadcn/ui/tooltip";
import { Button } from "@/shadcn/ui/button";
import { cn } from "@/util/util";

export type TooltipIconButtonProps = ComponentPropsWithRef<typeof Button> & {
    tooltip: string;
    side?: "top" | "bottom" | "left" | "right";
};

export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
    ({ children, tooltip, side = "bottom", className, size = "icon", ...rest }, ref) => {
        const sizeCls = size === "icon-xs" ? "" : "size-6 p-1";
        return (
            <TooltipProvider delayDuration={0}>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            variant="ghost"
                            size={size}
                            {...rest}
                            className={cn(
                                "aui-button-icon cursor-pointer transition-[background-color,color,transform,opacity] duration-100 hover:!bg-fg-overlay-1 hover:!text-foreground active:!bg-fg-overlay-2 active:!text-foreground active:scale-95 data-[state=open]:!bg-fg-overlay-2 data-[state=open]:!text-foreground focus-visible:!bg-fg-overlay-2",
                                sizeCls,
                                className
                            )}
                            ref={ref}
                        >
                            <Slot.Slottable>{children}</Slot.Slottable>
                            <span className="aui-sr-only sr-only">{tooltip}</span>
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side={side}>{tooltip}</TooltipContent>
                </Tooltip>
            </TooltipProvider>
        );
    }
);

TooltipIconButton.displayName = "TooltipIconButton";
