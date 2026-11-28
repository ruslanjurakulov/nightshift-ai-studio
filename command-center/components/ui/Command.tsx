"use client";
/*
 * Ported from shadcn/ui (MIT, Copyright (c) 2023 shadcn), registry new-york-v4 ui/command.tsx, fetched 2026-11-28 (CLI 4.23.1),
 * on cmdk (MIT, Copyright (c) 2022 Paco Coursey). Full notices: THIRD_PARTY_NOTICES.
 *
 * Adapted: painted by components/ui/primitives.css on --ds-* tokens; CommandDialog takes its title, description and close name
 * as required props (shadcn's defaults are English sentences); CommandShortcut is dropped.
 *
 * cmdk is a combobox: focus stays in the search box and ↑/↓ move a highlight (aria-activedescendant), so its `aria-selected`
 * means "highlighted", not "chosen". Use it for a palette of actions; a list whose rows carry a lasting choice (the model sheet)
 * keeps a listbox, where aria-selected is the choice.
 */
import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import "./primitives.css";

function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return <CommandPrimitive data-slot="command" className={cn("ui-command", className)} {...props} />;
}

function CommandDialog({
  title,
  description,
  closeLabel,
  children,
  ...props
}: React.ComponentProps<typeof Dialog> & {
  title: string;
  description: string;
  closeLabel: string | null;
  children: React.ReactNode;
}) {
  return (
    <Dialog {...props}>
      <DialogContent closeLabel={closeLabel} className="p-0">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        {/* cmdk labels its input and list by this (aria-labelledby on its own hidden label); without it the combobox is unnamed. */}
        <Command label={title}>{children}</Command>
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="ui-command-input-row">
      <Search aria-hidden className="size-4 shrink-0 text-[var(--ds-muted)]" />
      <CommandPrimitive.Input data-slot="command-input" className={cn("ui-command-input", className)} {...props} />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return <CommandPrimitive.List data-slot="command-list" className={cn("ui-command-list", className)} {...props} />;
}

function CommandEmpty({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty data-slot="command-empty" className={cn("ui-command-empty", className)} {...props} />;
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return <CommandPrimitive.Group data-slot="command-group" className={cn("ui-command-group", className)} {...props} />;
}

function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator data-slot="command-separator" className={cn("ui-command-separator", className)} {...props} />;
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return <CommandPrimitive.Item data-slot="command-item" className={cn("ui-command-item", className)} {...props} />;
}

export { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator };
