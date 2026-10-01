"use client";

import { createContext, useContext } from "react";

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
const ShellContext = createContext<{ operator: boolean }>({ operator: true });

export function ShellProvider({ operator, children }: { operator: boolean; children: React.ReactNode }) {
  return <ShellContext.Provider value={{ operator }}>{children}</ShellContext.Provider>;
}

export function useShell(): { operator: boolean } {
  return useContext(ShellContext);
}
