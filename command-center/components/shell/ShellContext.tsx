"use client";

import { createContext, useContext } from "react";
import { NO_NAV_FEATURES, type NavFeatures } from "@/lib/navigation";

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
const ShellContext = createContext<{ operator: boolean; features: NavFeatures }>({ operator: true, features: NO_NAV_FEATURES });

/**
 * `features` are the switches the SERVER read for this request (lib/navigation NavFeatures): which optional sections are listed.
 * Without a provider, and when the layout passes none, they are all off, so a section behind a switch is never linked by accident.
 */
export function ShellProvider({
  operator,
  features = NO_NAV_FEATURES,
  children,
}: {
  operator: boolean;
  features?: NavFeatures;
  children: React.ReactNode;
}) {
  return <ShellContext.Provider value={{ operator, features }}>{children}</ShellContext.Provider>;
}

export function useShell(): { operator: boolean; features: NavFeatures } {
  return useContext(ShellContext);
}
