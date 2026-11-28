"use client";
/*
 * Ported from shadcn/ui (MIT, Copyright (c) 2023 shadcn), registry new-york-v4 ui/popover.tsx, fetched 2026-11-28 (CLI 4.23.1),
 * on Radix Primitives (MIT, Copyright (c) 2022 WorkOS). Full notices: THIRD_PARTY_NOTICES.
 *
 * Adapted: painted by components/ui/primitives.css on --ds-* tokens; the header/title/description helpers are dropped (a popover
 * here takes the type roles directly). Radix places it against the viewport's edges and returns focus to the trigger.
 */
import * as React from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "@/lib/cn";
import "./primitives.css";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;
const PopoverClose = PopoverPrimitive.Close;

function PopoverContent({
  className,
  align = "center",
  sideOffset = 6,
  collisionPadding = 8,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn("ui-popover", className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverAnchor, PopoverClose, PopoverContent, PopoverTrigger };
