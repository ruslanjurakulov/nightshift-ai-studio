/**
 * Where a screen sits in the app, and where "back" goes from it.
 *
 * The sidebar, the breadcrumbs and the tab title all read the same list below,
 * so a section renamed in the dictionary is renamed everywhere at once — a
 * breadcrumb that disagrees with the rail it sits beside is worse than none.
 *
 * Pure: no React, no window. The client pieces (components/navigation/*) feed
 * it the pathname and the in-app history they have tracked.
 */

import type { Dictionary } from "@/lib/i18n";

export type NavKey = Exclude<keyof Dictionary["nav"], "more" | "allSections" | "gManage" | "gIntel" | "gSystem" | "menu" | "sections">;
/**
 * A screen's name in breadcrumbs, tabs and the tab title. Wider than NavKey:
 * All sections is the operator's phone page and never a rail entry of its own.
 */
export type SectionKey = NavKey | "home" | "allSections";
export type NavGroupLabel = keyof Pick<Dictionary["nav"], "gManage" | "gIntel" | "gSystem">;
export interface NavItem {
  href: string;
  key: NavKey;
}
export interface SectionItem {
  href: string;
  key: SectionKey;
}
export interface NavGroup {
  label?: NavGroupLabel;
  items: NavItem[];
}

/** The ground floor. Named, like every other section — `/` only redirects here. */
export const HOME = "/command-center";

/**
 * A customer's first screen after sign-in ("Bosh sahifa"): what to post next,
 * the quick tools, their channels and what they made. The customer rail's first
 * entry (Nightshift Studio is its own entry beside it).
 */
export const CUSTOMER_HOME = "/home";

/**
 * Where a viewer starts: the operator on the Command Center, a customer on
 * Home — the first screen of their first destination, where things are made.
 */
export function landingSection(operator: boolean): string {
  return operator ? HOME.slice(1) : CUSTOMER_HOME.slice(1);
}

/**
 * The primary navigation, in rail order. The first group has no heading: the
 * daily loop is four entries (the Command Center, Nightshift Studio, the Inbox,
 * Analytics). Every creative tool lives under the one Studio entry
 * (docs/studio/STUDIO_IA.md §4): the owner's complaint was eight sections that
 * felt unrelated. SideNav attaches the icons.
 *
 * The creative screens are still listed here, after Analytics, so breadcrumbs,
 * tab titles, the palette and the customer/operator gate still know them by
 * name; STUDIO_HOUSED_KEYS keeps them out of the rail itself.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    items: [
      { href: HOME, key: "command" },
      { href: "/studio", key: "studio" },
      // Trend templates (migration 0181): ready formats that open Create prefilled. A customer rail entry of its own.
      { href: "/trends", key: "trends" },
      // Comments on the channel's videos, with drafted replies a person approves (migration 0081).
      { href: "/inbox", key: "inbox" },
      { href: "/analytics", key: "analytics" },
      // Housed in Nightshift Studio (hidden from the rail, reached from Studio home's tiles):
      { href: "/create", key: "create" },
      { href: "/videos", key: "videos" },
      // Brand look: it was /studio, and is one click from Studio home (the Channel look chip).
      { href: "/studio/look", key: "brandLook" },
      { href: "/styles", key: "styles" },
      // Brand kits, campaigns and ad concepts (migration 0131). Shown only while NIGHTSHIFT_ADS_FACTORY is on: see FEATURE_GATED below.
      { href: "/ads", key: "ads" },
      // Character Studio (migration 0137). Shown only while NIGHTSHIFT_CHARACTER_STUDIO is on: see FEATURE_GATED below.
      { href: "/character-studio", key: "characterStudio" },
      { href: "/library", key: "library" },
      { href: "/editor", key: "editor" },
      { href: "/workflows", key: "workflows" },
      { href: "/pipeline", key: "pipeline" },
    ],
  },
  {
    label: "gManage",
    items: [
      { href: "/channels", key: "channels" },
      { href: "/accounts", key: "accounts" },
      { href: "/portfolio", key: "portfolio" },
      { href: "/providers", key: "providers" },
      { href: "/models", key: "models" },
      { href: "/margin", key: "margin" },
      // Revenue, people, usage and retention for the platform owner (migration 0182). Owner-only: not in CUSTOMER_NAV_KEYS, and every read refuses an admin too.
      { href: "/owner-analytics", key: "ownerAnalytics" },
      // People, workspaces and the credits each spent and bought (migration 0138). Operator-only: not in CUSTOMER_NAV_KEYS.
      { href: "/customers", key: "customers" },
      { href: "/billing", key: "billing" },
      { href: "/credits", key: "credits" },
      // The plan's allowance and the extra-credits switch (migration 0094): reached from Credits and the account menu.
      { href: "/usage", key: "usage" },
      { href: "/series", key: "series" },
      { href: "/agents", key: "agents" },
      { href: "/jobs", key: "jobs" },
    ],
  },
  {
    label: "gIntel",
    items: [
      { href: "/intelligence", key: "advisory" },
      { href: "/intelligence-map", key: "intelligence" },
      { href: "/decisions", key: "decisions" },
      { href: "/learning", key: "learning" },
      { href: "/memory", key: "memory" },
      { href: "/topics", key: "topics" },
      { href: "/measurement", key: "measure" },
      { href: "/feedback-loop", key: "feedback" },
      { href: "/autonomy", key: "autonomy" },
    ],
  },
  {
    label: "gSystem",
    items: [
      { href: "/getting-started", key: "onboarding" },
      { href: "/organization", key: "organization" },
      { href: "/developers", key: "developers" },
      { href: "/members", key: "members" },
      { href: "/security", key: "security" },
      { href: "/approvals", key: "approvals" },
      // The brand channel's posts, approved here by the owner; the page is off unless NIGHTSHIFT_MARKETING_POSTS is on.
      { href: "/marketing", key: "marketing" },
      // The owner's vendor API keys (checked with the vendor and forgotten: nothing is stored); the page is off unless NIGHTSHIFT_MODEL_KEYS is on.
      { href: "/model-keys", key: "modelKeys" },
      { href: "/alerts", key: "alerts" },
      { href: "/audit", key: "audit" },
      { href: "/time-machine", key: "timeMachine" },
      { href: "/integrations", key: "integrations" },
      { href: "/design", key: "design" },
      { href: "/errors", key: "errors" },
      { href: "/logs", key: "logs" },
    ],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/**
 * Switches the SERVER read for this request (never a NEXT_PUBLIC value) that decide whether a section is listed at all.
 * The (app) layout reads them and hands them to the shell (components/shell/ShellContext); every list below takes them as an
 * argument and defaults to "all off", so a caller that forgets to pass them hides the section rather than showing a link to a 404.
 */
export interface NavFeatures {
  /** NIGHTSHIFT_ADS_FACTORY (lib/adsFactory/flag.ts): the Ads workspace. */
  adsFactory: boolean;
  /** NIGHTSHIFT_CHARACTER_STUDIO (lib/characterStudio/model.ts): Character Studio. */
  characterStudio: boolean;
  /**
   * NIGHTSHIFT_FILM_STUDIO (lib/server/films.ts), already resolved for this viewer (`admins` lists it for a platform admin only):
   * Studio's Projects section, STUDIO_PROJECTS. Absent reads as off. It is not a rail entry of its own: it is listed beside the
   * Studio's desks (the desk bar, the customer sidebar's Create group and Studio's overview).
   */
  filmStudio?: boolean;
}

/** Studio → Projects: a whole video planned scene by scene (migration 0166). Under /create, the Studio's own address. */
export const STUDIO_PROJECTS = "/create/projects";

export const NO_NAV_FEATURES: NavFeatures = { adsFactory: false, characterStudio: false };

/** A section that exists only while its switch is on. Off: no rail entry, no tab, and its page answers 404 on its own. */
const FEATURE_GATED: Partial<Record<SectionKey, keyof NavFeatures>> = { ads: "adsFactory", characterStudio: "characterStudio" };

/** Is this section listed for a request with these switches? Hiding is presentation; the page and its routes check the switch themselves. */
export function navShown(key: SectionKey, features: NavFeatures = NO_NAV_FEATURES): boolean {
  const flag = FEATURE_GATED[key];
  return flag === undefined || features[flag] === true;
}

/**
 * The operator's phone: "All sections", the page behind the bottom bar's More tab. It lists the whole
 * console, so a phone needs no drawer to reach a screen. Operator-only like every screen not in
 * CUSTOMER_NAV_KEYS, and not a rail entry.
 */
export const ALL_SECTIONS = "/sections";

/** Every named screen: the rail's, plus Home (a customer screen with no rail icon) and All sections. */
export const SECTION_ITEMS: readonly SectionItem[] = [
  { href: CUSTOMER_HOME, key: "home" },
  { href: ALL_SECTIONS, key: "allSections" },
  ...NAV_ITEMS,
];

/**
 * The sections a customer's workspace is made of — everything a person who
 * signed up with an email needs to make and publish videos, buy credits and
 * run their workspace. The rest of NAV_GROUPS is the platform operator's
 * console (providers, agents, the intelligence stack, logs, the platform team)
 * and is shown only to a platform owner/admin.
 *
 * The setup checklist ("onboarding", /getting-started) is not here either: it
 * is the platform operator's health check of the deployment, so it is not in a
 * customer's rail, tabs or palette, and a customer who opens its URL is sent to
 * Home like any other operator screen.
 *
 * Two-person publish approval ("approvals") is not here: a workspace has one
 * person, so a second approver cannot exist. The screen
 * and the database rule stay for the operator (and a future Teams plan).
 *
 * Presentation and routing only: RLS decides what anyone may read, and every
 * API route re-checks its own role. Hiding a section is not what protects it.
 */
export const CUSTOMER_NAV_KEYS: readonly NavKey[] = [
  "command",
  "create",
  "trends",
  "videos",
  "inbox",
  "studio",
  "brandLook",
  "styles",
  "library",
  "editor",
  "workflows",
  "models",
  "channels",
  "credits",
  "usage",
  "series",
  // The Ads workspace: a customer's own brand kits and campaigns (shown only while its switch is on).
  "ads",
  // Character Studio: swap the people in a customer's own video (shown only while its switch is on).
  "characterStudio",
  "organization",
  "developers",
];

/**
 * Never in the rail, for anyone: the cross-tenant "All Accounts" roll-up and
 * the platform team list. Both stay routable (a platform admin can still open
 * them by URL, and the breadcrumbs still name them), they just no longer sit
 * in a customer-shaped app's navigation.
 */
/**
 * The creative screens that live under the one Nightshift Studio entry. They keep their pages and
 * URLs (lib/studioRoutes.ts says where each will move once the canvas exists); the rail lists
 * Studio instead of them, and Studio's entry is lit on every one of them.
 */
export const STUDIO_HOUSED_KEYS: readonly NavKey[] = [
  "create",
  "videos",
  "brandLook",
  "styles",
  "ads",
  "characterStudio",
  "library",
  "editor",
  "workflows",
  "pipeline",
];

export const RAIL_HIDDEN_KEYS: readonly NavKey[] = ["accounts", "members", "trends", ...STUDIO_HOUSED_KEYS];

/** The customer's Trends screen: the trend templates (S3's /api/templates), each one opening Create prefilled. */
export const TRENDS = "/trends";
/** The customer's projects: Nightshift Studio's project shelf (the canvas projects and the editor's), which /editor redirects to. */
export const PROJECTS = "/studio?shelf=projects";

/**
 * A customer's rail: five places to make and find things, nothing else. Home asks "what shall we create?"; Create is the
 * one screen where a priced generation is started; Trends lists the templates; Projects and Library hold what was made.
 * Credits and Settings sit at the foot of the desktop sidebar (and behind the credit pill and the avatar on a phone).
 * Channels, the Inbox and Nightshift Studio's canvas keep their URLs and are reached from Projects, the avatar menu and ⌘K.
 */
export const CUSTOMER_RAIL: readonly NavItem[] = [
  { href: CUSTOMER_HOME, key: "home" },
  { href: "/create", key: "create" },
  { href: TRENDS, key: "trends" },
  { href: PROJECTS, key: "projects" },
  { href: "/library", key: "library" },
];

/**
 * Tab bars under a rail entry. Neither has one any more: Studio's tools are tiles on Studio home
 * (the SECTION_TABS.hub strip of eleven tabs is gone), and Settings is one plain page with
 * Developers (API keys) as its own entry. The groups stay, empty, because they still decide
 * which rail entry is lit (tabsFor).
 */
export const SECTION_TABS: Readonly<Record<RailGroup, readonly SectionItem[]>> = {
  studio: [],
  settings: [],
};

export type RailGroup = "studio" | "settings";

/** The housed screens as section paths ("/create"), plus the screens Studio home opens that have no rail key. */
export const STUDIO_SCREENS: readonly string[] = [
  "/studio",
  ...NAV_ITEMS.filter((i) => STUDIO_HOUSED_KEYS.includes(i.key)).map((i) => i.href),
  // The Presets gallery is opened from Studio and Home; it keeps Studio lit.
  "/presets",
];

/**
 * Screens that belong to a rail entry without being tabs of it: Studio owns every creative screen,
 * Settings owns its page and Developers, so the bottom bar and the sidebar keep the right entry lit.
 */
const RAIL_SCREENS: Readonly<Record<RailGroup, readonly string[]>> = {
  studio: STUDIO_SCREENS,
  settings: ["/organization", "/developers"],
};

/**
 * Studio home's tiles: every housed tool, then the customer's channel screens that used to be tabs
 * of the hub (Inbox, Series, Models), so none of them lost its way in. The key "presets" names the one
 * screen with no rail key. Filtered by navShown (switches) and sectionAllowed (operator-only).
 */
export type StudioTileKey =
  | Extract<NavKey, "create" | "trends" | "library" | "editor" | "workflows" | "styles" | "brandLook" | "pipeline" | "ads" | "characterStudio" | "inbox" | "series" | "models">
  | "presets";

export interface StudioTile {
  href: string;
  key: StudioTileKey;
  group: "make" | "channel";
}

export const STUDIO_TILES: readonly StudioTile[] = [
  { href: "/create", key: "create", group: "make" },
  { href: "/library", key: "library", group: "make" },
  { href: "/editor", key: "editor", group: "make" },
  { href: "/workflows", key: "workflows", group: "make" },
  { href: "/styles", key: "styles", group: "make" },
  { href: "/presets", key: "presets", group: "make" },
  // Trends (0183): ready formats that open Create prefilled.
  { href: "/trends", key: "trends", group: "make" },
  { href: "/studio/look", key: "brandLook", group: "make" },
  { href: "/pipeline", key: "pipeline", group: "make" },
  { href: "/ads", key: "ads", group: "make" },
  { href: "/character-studio", key: "characterStudio", group: "make" },
  { href: "/inbox", key: "inbox", group: "channel" },
  { href: "/series", key: "series", group: "channel" },
  { href: "/models", key: "models", group: "channel" },
];

/** The tiles a viewer sees: a switched-off section and an operator-only one (for a customer) are left out. */
export function studioTilesFor(operator: boolean, features: NavFeatures = NO_NAV_FEATURES): StudioTile[] {
  return STUDIO_TILES.filter((tile) => {
    if (tile.key !== "presets" && !navShown(tile.key, features)) return false;
    if (!sectionAllowed(tile.href.slice(1), operator)) return false;
    // The operator's rail already lists Inbox, Series and Models; the tiles are for the customer, whose rail does not.
    if (tile.group === "channel" && operator) return false;
    return true;
  });
}

/**
 * The Studio's tools, in the order the customer sidebar lists them: the
 * make-and-edit tools, then the voice tools (change the voice of a recording,
 * dub it), then Describe (a picture -> a prompt for it), then Upscale video. Mirrors COMPOSER_CAPABILITIES in lib/creative/studio.ts (kept out
 * of this pure module on purpose; tests/navigation-shell.test.ts holds the
 * two in step, and that every link is one prefillFromQuery accepts).
 */
export const STUDIO_TOOLS = ["t2i", "t2v", "tts", "edit", "i2v", "upscale", "remove_bg", "voice_change", "dub", "describe", "video_upscale"] as const;
export type StudioTool = (typeof STUDIO_TOOLS)[number];

export interface ToolLink {
  tool: StudioTool;
  /** `/create?tool=…` — it opens the Studio with that tool chosen; it fills the
   *  form only, so nothing is priced or spent by following it. */
  href: string;
}

export function toolHref(tool: StudioTool): string {
  return `/create?tool=${tool}`;
}

/**
 * A customer's desktop sidebar: Studio on top, the tools as direct links (the
 * way a creative app lists them), then their work, and the account at the foot.
 * Every destination is a customer section — never an operator screen — and the
 * five rail destinations (CUSTOMER_RAIL, which the phone's bottom bar keeps)
 * are all here, so the two never disagree about what a customer can reach.
 */
export interface CustomerSidebar {
  home: NavItem;
  tools: readonly ToolLink[];
  work: readonly NavItem[];
  footer: readonly NavItem[];
}

export const CUSTOMER_SIDEBAR: CustomerSidebar = {
  home: { href: CUSTOMER_HOME, key: "home" },
  // Kept as data for the canvas's Add node menu (STUDIO_IA.md §4); the sidebar no longer lists them, Studio home's
  // Create tile and its desk chips do. Every link still works (tests/studio-routes.test.ts).
  tools: STUDIO_TOOLS.map((tool) => ({ tool, href: toolHref(tool) })),
  // The rail after Home, in the same order the phone's bottom bar draws it.
  work: CUSTOMER_RAIL.slice(1),
  footer: [
    { href: "/credits", key: "credits" },
    { href: "/organization", key: "settings" },
  ],
};

/**
 * Which sidebar row is the current place, from the section path (no channel,
 * e.g. "/create"). Home owns /home; Studio owns every creative screen and the
 * channel screens its tiles open (Series, Models); Settings owns its page.
 * The query no longer matters: the tools are not rows of their own any more.
 */
export function sidebarCurrent(section: string): string | null {
  const parts = section.split("/").filter(Boolean);
  const first = "/" + (parts[0] ?? "");
  if (first === CUSTOMER_HOME) return "home";
  if (first === TRENDS) return "trends";
  // The projects shelf and the canvas a project opens in are both Projects (the section path carries no query).
  if (first === "/studio" && parts.length === 1) return "projects";
  if (first === "/library") return "library";
  if (first === "/developers" || first === "/organization") return "settings";
  // Usage is part of the credits story (plan allowance, extra credits): its row is Credits.
  if (first === "/usage" || first === "/credits") return "credits";
  // Every other creative screen (a tool, the editor, styles, presets, a video's page, Series, Models) is part of making.
  if (first === "/series" || first === "/models") return "create";
  if (tabsFor(first.slice(1))?.rail === "studio") return "create";
  return null;
}

/** The tab group (and its rail entry) that `section` belongs to, if any; a tab whose switch is off is left out. */
export function tabsFor(
  section: string,
  features: NavFeatures = NO_NAV_FEATURES,
): { rail: RailGroup; items: readonly SectionItem[] } | null {
  // Only the first segment decides: /studio/look and /videos/<id> belong where /studio and /videos do.
  const href = "/" + (section.split("/").filter(Boolean)[0] ?? "");
  for (const rail of ["studio", "settings"] as const) {
    if (SECTION_TABS[rail].some((i) => i.href === href) || RAIL_SCREENS[rail].includes(href)) {
      return { rail, items: SECTION_TABS[rail].filter((i) => navShown(i.key, features)) };
    }
  }
  return null;
}

/** One key of the operator's phone tab bar; `more` is the page of every section. */
export interface OperatorTab {
  href: string;
  key: "home" | "studio" | "billing" | "alerts" | "more";
  /** The icon: a rail key, or the sections page's own. */
  icon: NavKey | "sections";
}

/**
 * The platform owner's bottom bar on a phone, in thumb order: the Command Center (money, failures, what waits
 * for them at a glance), Nightshift Studio (where the videos now are), billing, alerts, and More, a visible tab to the page listing every other
 * section. Visible navigation, never a drawer behind a button. Operator-only: SideNav draws it for the
 * operator alone, and every route here is an operator screen the layout redirects a customer away from.
 */
export const OPERATOR_TABS: readonly OperatorTab[] = [
  { href: HOME, key: "home", icon: "command" },
  { href: "/studio", key: "studio", icon: "studio" },
  { href: "/billing", key: "billing", icon: "billing" },
  { href: "/alerts", key: "alerts", icon: "alerts" },
  { href: ALL_SECTIONS, key: "more", icon: "sections" },
];

/**
 * Which operator tab is the current place, from the section path ("/billing"). Home, Studio, Billing and
 * Alerts light for their own screens (Studio for every creative screen, a video's page too); every other
 * screen belongs to More.
 */
export function operatorTabCurrent(section: string): OperatorTab["key"] {
  const first = "/" + (section.split("/").filter(Boolean)[0] ?? "");
  if (first === HOME || first === "/") return "home";
  if (STUDIO_SCREENS.includes(first)) return "studio";
  const own = OPERATOR_TABS.find((t) => t.key !== "more" && t.href === first);
  return own ? own.key : "more";
}

/** The rail for a viewer: the five customer destinations, or the operator's console. */
export function navGroupsFor(operator: boolean, features: NavFeatures = NO_NAV_FEATURES): NavGroup[] {
  if (!operator) return [{ items: [...CUSTOMER_RAIL] }];
  const keep = (item: NavItem) => !RAIL_HIDDEN_KEYS.includes(item.key) && navShown(item.key, features);
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter(keep) })).filter((g) => g.items.length > 0);
}

/** Section paths (no leading slash) a customer may open. */
export const CUSTOMER_SECTIONS: readonly string[] = [
  CUSTOMER_HOME.slice(1),
  ...NAV_ITEMS.filter((i) => CUSTOMER_NAV_KEYS.includes(i.key)).map((i) => i.href.slice(1)),
];

/**
 * Is `section` (the URL segment after the channel) a screen only the platform
 * operator opens? Unknown segments are not: they 404 on their own, and an
 * empty one is the channel's index, which lands on the Command Center.
 */
export function isOperatorOnlySection(section: string): boolean {
  if (!section) return false;
  const known = SECTION_ITEMS.some((i) => i.href === "/" + section);
  return known && !CUSTOMER_SECTIONS.includes(section);
}

/** Should a request for `section` bounce a viewer who is not the operator? */
export function sectionAllowed(section: string, operator: boolean): boolean {
  return operator || !isOperatorOnlySection(section);
}

/** `/chronos/videos/abc?x=1` → slug "chronos", segments ["videos", "abc"]. */
export function splitPath(pathname: string): { slug: string; segments: string[] } {
  const clean = pathname.split(/[?#]/)[0] ?? "";
  const [slug = "", ...segments] = clean.split("/").filter(Boolean);
  return { slug, segments };
}

export function isHomePath(pathname: string): boolean {
  const { segments } = splitPath(pathname);
  return segments.length === 1 && "/" + segments[0] === HOME;
}

export type Crumb =
  /** The channel the URL is about — context, not a destination. */
  | { kind: "channel"; slug: string }
  /** A section the sidebar knows, labelled from the sidebar's own key. */
  | { kind: "section"; key: SectionKey; href: string }
  /** A segment below a section (`/videos/<id>`, `/channels/new`), or a route
   *  the sidebar does not list. Labelled by the caller, which knows the words. */
  | { kind: "detail"; segment: string; parent: string | null; href: string };

/**
 * The trail for a pathname: [channel, Command Center, section, detail…].
 *
 * The channel comes first and always — whether to SHOW it (a single-channel
 * deployment has nothing to distinguish) is the caller's choice. The Command
 * Center itself is the whole trail on its own ground floor.
 */
export function breadcrumbs(pathname: string): Crumb[] {
  const { slug, segments } = splitPath(pathname);
  if (!slug) return [];
  const at = (p: string) => `/${slug}${p}`;
  const crumbs: Crumb[] = [{ kind: "channel", slug }, { kind: "section", key: "command", href: at(HOME) }];
  if (segments.length === 0) return crumbs;

  const sectionHref = "/" + segments[0];
  if (sectionHref === HOME) return crumbs;
  const item = SECTION_ITEMS.find((i) => i.href === sectionHref);
  // A housed creative screen sits under Nightshift Studio, and says so: Studio › Styles.
  if (sectionHref !== "/studio" && STUDIO_SCREENS.includes(sectionHref)) crumbs.push({ kind: "section", key: "studio", href: at("/studio") });
  if (item) crumbs.push({ kind: "section", key: item.key, href: at(item.href) });
  else crumbs.push({ kind: "detail", segment: segments[0], parent: null, href: at(sectionHref) });

  let href = sectionHref;
  for (const segment of segments.slice(1)) {
    href += "/" + segment;
    crumbs.push({ kind: "detail", segment: decodeSegment(segment), parent: segments[0], href: at(href) });
  }
  return crumbs;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Where "up" is from a pathname, on the same channel: `/c/videos/abc` →
 * `/c/videos`, `/c/integrations` → `/c/command-center`. Null on the ground
 * floor, which has no parent.
 */
export function parentPath(pathname: string): string | null {
  const { slug, segments } = splitPath(pathname);
  if (!slug) return null;
  if (segments.length === 0) return `/${slug}${HOME}`;
  if (segments.length === 1) {
    if ("/" + segments[0] === HOME) return null;
    // A housed creative screen's way up is Studio home, the place that lists it.
    return segments[0] !== "studio" && STUDIO_SCREENS.includes("/" + segments[0]) ? `/${slug}/studio` : `/${slug}${HOME}`;
  }
  return `/${slug}/${segments.slice(0, -1).join("/")}`;
}

/** Enough to cover any real session; bounded so the list cannot grow forever. */
export const MAX_TRACKED = 50;

/**
 * Keep a record of the in-app pages this tab has visited, top = current.
 *
 * Why not `history.length`: it counts pages from before the app (a search
 * result, the login screen), so a back based on it can leave the product. And
 * `document.referrer` is not updated by client-side navigation at all. This
 * list only ever holds pages this app rendered in this tab.
 *
 * `viaPop` is a browser back/forward. Stepping back to the page under the top
 * pops. Any other pop is a jump the list cannot place (forward past a reload,
 * or back past where tracking started): the list restarts from here, so the
 * next "back" falls to the logical parent rather than guessing at an entry
 * that may be another site.
 */
export function recordVisit(stack: readonly string[], pathname: string, viaPop: boolean): string[] {
  const top = stack[stack.length - 1];
  if (top === pathname) return [...stack];
  if (viaPop) {
    if (stack.length > 1 && stack[stack.length - 2] === pathname) return stack.slice(0, -1);
    return [pathname];
  }
  const next = [...stack, pathname];
  return next.length > MAX_TRACKED ? next.slice(-MAX_TRACKED) : next;
}

export type BackAction = { kind: "history" } | { kind: "navigate"; href: string };

/**
 * What the back arrow does from `pathname`, given how many in-app pages sit
 * under it in this tab's history.
 *
 * With an in-app page behind: the browser's own back, so scroll position and
 * the page you actually came from are restored. With none (a fresh tab, a
 * pasted link, a reload): the logical parent — never `history.back()`, which
 * would leave the app. Null only on the ground floor with nothing behind.
 */
export function resolveBack(pathname: string, depth: number): BackAction | null {
  if (depth > 0) return { kind: "history" };
  const parent = parentPath(pathname);
  return parent ? { kind: "navigate", href: parent } : null;
}

/**
 * The stack to start a tab with, from what sessionStorage held before this
 * document loaded.
 *
 * Only a reload may resume it: the history behind a reloaded page is the same
 * history the stack described. A page reached any other way (a typed URL, a
 * link from another site, back from another site) may have anything behind it
 * — resuming then could send "back" out of the app — so tracking restarts.
 */
export function restoreStack(stored: unknown, pathname: string, navigationType: string | null): string[] {
  if (navigationType !== "reload" || !Array.isArray(stored)) return [pathname];
  const clean = stored.filter((p): p is string => typeof p === "string" && p.startsWith("/")).slice(-MAX_TRACKED);
  return clean.length > 0 && clean[clean.length - 1] === pathname ? clean : [pathname];
}

/**
 * The section a pathname's tab title names: the deepest crumb the sidebar
 * knows. `/c/videos/abc` is titled "Videos", which is truer than an id.
 */
export function titleKey(pathname: string): SectionKey | null {
  const sections = breadcrumbs(pathname).filter((c): c is Extract<Crumb, { kind: "section" }> => c.kind === "section");
  return sections.length > 0 ? sections[sections.length - 1].key : null;
}
