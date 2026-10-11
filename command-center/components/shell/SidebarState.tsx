"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Whether the customer's sidebar is collapsed to its icon rail, remembered per browser.
 *
 * The truth lives in localStorage (`ns-sidebar`), every read and write inside try/catch: a private window,
 * blocked site data or a throwing accessor leaves the sidebar working for the visit, just not remembered. It is
 * mirrored to a cookie (`ns_sidebar`, a preference only: no identity, no secret) so the layout can draw the right
 * width on the server and the page does not jump when it loads. Without either, the sidebar starts open.
 * Presentation only: it decides how wide a rail is drawn, never what anyone may open.
 */
export const SIDEBAR_KEY = "ns-sidebar";
export const SIDEBAR_COOKIE = "ns_sidebar";

type SidebarState = { collapsed: boolean; toggle: () => void };

const SidebarContext = createContext<SidebarState>({ collapsed: false, toggle: () => {} });

function readStored(): boolean | null {
  try {
    const v = window.localStorage.getItem(SIDEBAR_KEY);
    return v === "collapsed" ? true : v === "open" ? false : null;
  } catch {
    return null;
  }
}

function writeStored(collapsed: boolean) {
  const v = collapsed ? "collapsed" : "open";
  try {
    window.localStorage.setItem(SIDEBAR_KEY, v);
  } catch {
    // not remembered in this browser; the choice still holds for the visit
  }
  try {
    document.cookie = `${SIDEBAR_COOKIE}=${v}; Path=/; Max-Age=31536000; SameSite=Lax`;
  } catch {
    // no cookie either: the next page load starts open
  }
}

export function SidebarProvider({ initialCollapsed = false, children }: { initialCollapsed?: boolean; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  // The cookie drew the first frame; if it was cleared but the browser still remembers, catch up once.
  useEffect(() => {
    const stored = readStored();
    if (stored !== null && stored !== initialCollapsed) setCollapsed(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      writeStored(!c);
      return !c;
    });
  }, []);

  const value = useMemo(() => ({ collapsed, toggle }), [collapsed, toggle]);
  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarState {
  return useContext(SidebarContext);
}
