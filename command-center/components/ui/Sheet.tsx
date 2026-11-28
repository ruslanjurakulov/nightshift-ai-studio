"use client";
/*
 * Ported from shadcn/ui (MIT, Copyright (c) 2023 shadcn), registry new-york-v4 ui/sheet.tsx, fetched 2026-11-28 (CLI 4.23.1),
 * on Radix Primitives' Dialog (MIT, Copyright (c) 2022 WorkOS). Full notices: THIRD_PARTY_NOTICES.
 *
 * Adapted: painted by components/ui/primitives.css on --ds-* tokens; the side travels in a data attribute the stylesheet reads,
 * so the slide uses the --ds-dur-* tokens and stops under reduced motion; the close key's name is a required prop.
 *
 * A sheet is a dialog that arrives from an edge: on a phone the bottom one is the thumb's reach, where a centred box would sit
 * under the keyboard.
 */
import * as React from "react";
import { X } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { cn } from "@/lib/cn";
import "./primitives.css";

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetTitle = SheetPrimitive.Title;
const SheetDescription = SheetPrimitive.Description;

/** "auto" is the bottom sheet on a phone and a centred dialog from 640px (primitives.css). */
export type SheetSide = "top" | "right" | "bottom" | "left" | "auto";

function SheetContent({
  className,
  children,
  side = "right",
  closeLabel,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: SheetSide;
  /** The close key's accessible name, from lib/i18n; null draws no close key (the content brings its own). */
  closeLabel: string | null;
}) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay data-slot="sheet-overlay" className="ui-overlay" />
      <SheetPrimitive.Content data-slot="sheet-content" data-side={side} className={cn("ui-sheet", className)} {...props}>
        {children}
        {closeLabel !== null && (
          <SheetPrimitive.Close className="ui-close absolute right-3 top-3" aria-label={closeLabel}>
            <X aria-hidden className="size-4" />
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle, SheetTrigger };
