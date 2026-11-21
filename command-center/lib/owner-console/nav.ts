/**
 * The Owner Console's map (/owner, the platform owner's account in the account switcher). Pure: the shell, the pages and
 * the tests read the same list.
 *
 * The console's own sections are the seven below. Until a section's page is built (S8 fills them), it lists the existing
 * owner tools that already hold its data: those keep their URLs and their pages, and are not rewritten. A tool link is a
 * bare section path ("/margin"): the middleware puts the remembered channel in front of it, as for any section link.
 */
import type { OwnerConsoleDictionary } from "@/lib/i18n/owner-console/en";

export const OWNER_CONSOLE_PATH = "/owner";

export const OWNER_SECTION_KEYS = ["overview", "users", "revenue", "providers", "health", "ai", "settings"] as const;
export type OwnerSectionKey = (typeof OWNER_SECTION_KEYS)[number];

export type OwnerToolKey = keyof OwnerConsoleDictionary["tools"];

export interface OwnerSection {
  key: OwnerSectionKey;
  href: string;
  /** Existing owner tools that hold this section's data today. */
  tools: readonly { key: OwnerToolKey; href: string }[];
}

export const OWNER_SECTIONS: readonly OwnerSection[] = [
  {
    key: "overview",
    href: OWNER_CONSOLE_PATH,
    tools: [
      { key: "ownerAnalytics", href: "/owner-analytics" },
      { key: "commandCenter", href: "/command-center" },
    ],
  },
  {
    key: "users",
    href: `${OWNER_CONSOLE_PATH}/users`,
    tools: [
      { key: "analyticsUsers", href: "/owner-analytics/users" },
      { key: "analyticsUsage", href: "/owner-analytics/usage" },
      { key: "customers", href: "/customers" },
    ],
  },
  {
    key: "revenue",
    href: `${OWNER_CONSOLE_PATH}/revenue`,
    tools: [
      { key: "analyticsRevenue", href: "/owner-analytics/revenue" },
      { key: "forecast", href: "/owner-analytics/forecast" },
      { key: "runway", href: "/owner-analytics/runway" },
      { key: "tax", href: "/owner-analytics/tax" },
      { key: "margin", href: "/margin" },
    ],
  },
  {
    key: "providers",
    href: `${OWNER_CONSOLE_PATH}/providers`,
    tools: [
      { key: "providers", href: "/providers" },
      { key: "costs", href: "/owner-analytics/costs" },
      { key: "modelRegistry", href: "/models?view=manage" },
      { key: "modelKeys", href: "/model-keys" },
      { key: "billing", href: "/billing" },
    ],
  },
  {
    key: "health",
    href: `${OWNER_CONSOLE_PATH}/health`,
    tools: [
      { key: "errors", href: "/errors" },
      { key: "alerts", href: "/alerts" },
      { key: "jobs", href: "/jobs" },
      { key: "logs", href: "/logs" },
      { key: "audit", href: "/audit" },
    ],
  },
  { key: "ai", href: `${OWNER_CONSOLE_PATH}/ai`, tools: [] },
  { key: "settings", href: `${OWNER_CONSOLE_PATH}/settings`, tools: [{ key: "security", href: "/security" }] },
];

export function ownerSection(key: OwnerSectionKey): OwnerSection {
  const s = OWNER_SECTIONS.find((x) => x.key === key);
  if (!s) throw new Error(`unknown owner section ${key}`);
  return s;
}

/** Which section a pathname belongs to: the longest href that is the path or a parent of it. */
export function currentOwnerSection(pathname: string): OwnerSectionKey | null {
  const clean = pathname.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  let best: OwnerSection | null = null;
  for (const s of OWNER_SECTIONS) {
    if (clean === s.href || clean.startsWith(s.href + "/")) {
      if (!best || s.href.length > best.href.length) best = s;
    }
  }
  return best?.key ?? null;
}

/**
 * The Owner account's view rule (the platform owner with the switcher on "Owner"): the console and the owner tools it links
 * to, and nothing of the Studio or the workspace (Home, Create, the Studio, Library, channels, credits). Those open only in
 * the User account. A VIEW rule: who may read or write anything is still the real role, in either account, and an account
 * that is not the platform owner is never in this view (app/(app)/layout.tsx decides it from the database's answer).
 *
 * The tools are app sections under a channel (`/{channel}/margin`), so the rule is the section name: exactly the first
 * segment of a tool link above. The Models registry is an owner tool only in its management views (`?view=`); the plain
 * Models page is the customers' catalog.
 */
export const OWNER_TOOL_SECTIONS: ReadonlySet<string> = new Set(
  OWNER_SECTIONS.flatMap((s) => s.tools.map((t) => t.href.split(/[/?]/)[1] ?? "")).filter(Boolean),
);

/** Where a workspace URL goes in the Owner view: the console, which then says how to open the Studio. */
export const OWNER_VIEW_BLOCKED = `${OWNER_CONSOLE_PATH}?from=studio`;

/** May the Owner view open this app path (`/{channel}/{section}/…`, with its query)? */
export function ownerViewAllows(path: string, search: string = ""): boolean {
  const section = path.split("/")[2] ?? "";
  if (!OWNER_TOOL_SECTIONS.has(section)) return false;
  if (section === "models") return new URLSearchParams(search).has("view");
  return true;
}
