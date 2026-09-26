"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { recordVisit, resolveBack, restoreStack, titleKey } from "@/lib/navigation";

interface NavigationValue {
  /** The channel's display name for a URL slug, when the layout knew it. */
  channelName: (slug: string) => string | null;
  /** Whether a channel crumb says anything — false with one channel or none. */
  showChannel: boolean;
  /** Can `goBack` do anything from here? */
  canGoBack: () => boolean;
  goBack: () => void;
}

const NavigationContext = createContext<NavigationValue | null>(null);

const STORAGE_KEY = "nightshift:nav-stack";

function readStored(): unknown {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStored(stack: string[]) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stack));
  } catch {
    // Private mode or storage disabled: tracking still works for this document.
  }
}

function navigationType(): string | null {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry?.type ?? null;
  } catch {
    return null;
  }
}

/** In-app pages under the current one; 0 before the first visit is recorded. */
function depthOf(stack: string[] | null): number {
  return stack ? stack.length - 1 : 0;
}

/**
 * Mounted once in the app layout, which persists across navigations — unlike
 * the section template, which remounts on every one and so cannot remember
 * where the user has been.
 */
export function NavigationProvider({
  channelNames,
  children,
}: {
  /** slug → channel name, for the channels of the current organization. */
  channelNames: Record<string, string>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const stack = useRef<string[] | null>(null);
  const popped = useRef(false);
  const current = useRef(pathname);
  current.current = pathname;

  // popstate fires before the router re-renders with the new pathname, so the
  // flag is set by the time the effect below records the visit. A pop that
  // stays on the same pathname (a hash change) must not set it, or the next
  // ordinary link would be mistaken for a back and pop the stack.
  useEffect(() => {
    function onPop() {
      if (window.location.pathname !== current.current) popped.current = true;
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    stack.current =
      stack.current === null
        ? restoreStack(readStored(), pathname, navigationType())
        : recordVisit(stack.current, pathname, popped.current);
    popped.current = false;
    writeStored(stack.current);
  }, [pathname]);

  // The tab says which section it is — with a dozen tabs open, "Nightshift
  // Command Center" on every one of them names none. Set on the client because
  // the label is the sidebar's, in the viewer's language.
  useEffect(() => {
    const key = titleKey(pathname);
    document.title = key ? `${t.nav[key]} · ${t.brand.name}` : t.brand.name;
  }, [pathname, t]);

  const canGoBack = useCallback(() => resolveBack(current.current, depthOf(stack.current)) !== null, []);

  const goBack = useCallback(() => {
    const action = resolveBack(current.current, depthOf(stack.current));
    if (!action) return;
    if (action.kind === "history") router.back();
    else router.push(action.href);
  }, [router]);

  const value = useMemo<NavigationValue>(
    () => ({
      channelName: (slug) => channelNames[slug] ?? null,
      showChannel: Object.keys(channelNames).length > 1,
      canGoBack,
      goBack,
    }),
    [channelNames, canGoBack, goBack],
  );

  return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

export function useNavigation(): NavigationValue {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error("useNavigation must be used within NavigationProvider");
  return ctx;
}
