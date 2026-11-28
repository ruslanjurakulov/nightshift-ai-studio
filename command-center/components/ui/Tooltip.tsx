"use client";
/*
 * Ported from shadcn/ui (MIT, Copyright (c) 2023 shadcn), registry new-york-v4 ui/tooltip.tsx, fetched 2026-11-28 (CLI 4.23.1),
 * on Radix Primitives (MIT, Copyright (c) 2022 WorkOS). Full notices: THIRD_PARTY_NOTICES.
 *
 * Adapted: painted by components/ui/primitives.css on --ds-* tokens; the provider's delay is 300ms, not shadcn's 0, so a
 * pointer crossing a toolbar does not flash every label on the way.
 *
 * A tooltip only repeats a name the control already has (aria-label or visible text); it is never the only place a fact lives,
 * because a touch screen never hovers.
 */
import * as React from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "@/lib/cn";
import "./primitives.css";

function TooltipProvider({ delayDuration = 300, ...props }: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} {...props} />;
}

const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

function TooltipContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn("ui-tooltip", className)}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="ui-tooltip-arrow" width={10} height={5} />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
