"use client";
/*
 * Ported from shadcn/ui (MIT, Copyright (c) 2023 shadcn), registry new-york-v4 ui/tabs.tsx, fetched 2026-11-28 (CLI 4.23.1),
 * on Radix Primitives (MIT, Copyright (c) 2022 WorkOS). Full notices: THIRD_PARTY_NOTICES.
 *
 * Adapted: painted by components/ui/primitives.css on --ds-* tokens; the "line" variant and class-variance-authority are dropped
 * (one look until a screen needs a second). Radix gives the tablist pattern: one tab stop, ←/→ move, Home/End jump, and each
 * panel named by its tab.
 */
import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/lib/cn";
import "./primitives.css";

const Tabs = TabsPrimitive.Root;

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={cn("ui-tabs-list", className)} {...props} />;
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger data-slot="tabs-trigger" className={cn("ui-tabs-trigger", className)} {...props} />;
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("outline-none", className)} {...props} />;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
