"use client";
/*
 * Ported from shadcn/ui (MIT, Copyright (c) 2023 shadcn), registry new-york-v4 ui/dialog.tsx, fetched 2026-11-28 (CLI 4.23.1),
 * on Radix Primitives (MIT, Copyright (c) 2022 WorkOS). Full notices: THIRD_PARTY_NOTICES.
 *
 * Adapted: painted by components/ui/primitives.css on --ds-* tokens instead of shadcn's theme variables (they collide with ours);
 * the close key's name is a required prop, never a built-in English "Close"; the footer's built-in close Button is dropped
 * (it would bring shadcn's Button beside ours).
 *
 * What Radix brings that a hand-rolled dialog had to re-earn: focus trapped inside, Escape and an outside press close it, the
 * page behind is inert to a screen reader and does not scroll, and focus goes back to whatever opened it.
 */
import * as React from "react";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "@/lib/cn";
import { keepOpenOnNotice } from "@/components/ui/notices";
import "./primitives.css";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay data-slot="dialog-overlay" className={cn("ui-overlay", className)} {...props} />;
}

function DialogContent({
  className,
  children,
  closeLabel,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** The close key's accessible name, from lib/i18n; null draws no close key (the content brings its own). */
  closeLabel: string | null;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content data-slot="dialog-content" className={cn("ui-dialog", className)} {...props} onInteractOutside={keepOpenOnNotice(props.onInteractOutside)}>
        {children}
        {closeLabel !== null && (
          <DialogPrimitive.Close className="ui-close absolute right-3 top-3" aria-label={closeLabel}>
            <X aria-hidden className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn("ds-t-heading-md", className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("ds-t-body-sm text-[var(--ds-muted)]", className)}
      {...props}
    />
  );
}

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger };
