"use client";

import { createContext, useContext } from "react";
import { NO_NAV_FEATURES, type NavFeatures } from "@/lib/navigation";
import { UNKNOWN_TOOLS, type ToolAvailability } from "@/lib/tool-availability";

/**
 * Which frame the signed-in app is drawn in: the operator's console or the
 * customer's creative app. Set once by the (app) layout, which already knows
 * (lib/auth/org-roles isOperator). Presentation only — it decides how a page
 * is framed, never what anyone may open; the layout and RLS do that.
 *
 * Without a provider it reads as the operator's frame: that is how every
 * screen was drawn before, so a component rendered on its own (a test, a
 * story) keeps its old look.
 */
interface Shell {
  operator: boolean;
  features: NavFeatures;
  /** Which Studio tools have a model on sale (lib/tool-availability.ts); unknown draws every tool as before. */
  tools: ToolAvailability;
}

const ShellContext = createContext<Shell>({ operator: true, features: NO_NAV_FEATURES, tools: UNKNOWN_TOOLS });

/**
 * `features` are the switches the SERVER read for this request (lib/navigation NavFeatures): which optional sections are listed.
 * Without a provider, and when the layout passes none, they are all off, so a section behind a switch is never linked by accident.
 *
 * `tools` is the server's one read of what is on sale (lib/server/tool-availability.ts). Without it: unknown, so nothing is marked
 * unavailable on a guess. It is presentation: the quote and the create routes refuse an unsold model whatever a link looks like.
 */
export function ShellProvider({
  operator,
  features = NO_NAV_FEATURES,
  tools = UNKNOWN_TOOLS,
  children,
}: {
  operator: boolean;
  features?: NavFeatures;
  tools?: ToolAvailability;
  children: React.ReactNode;
}) {
  return <ShellContext.Provider value={{ operator, features, tools }}>{children}</ShellContext.Provider>;
}

export function useShell(): Shell {
  return useContext(ShellContext);
}
