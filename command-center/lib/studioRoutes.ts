/**
 * Where every old creative URL goes now that the tools live under one roof, Nightshift Studio
 * (docs/studio/STUDIO_IA.md §5, build step 1: "IA shell, no new behaviour").
 *
 * Pure: no React, no window, no fetch. The old `page.tsx` shims call it on the server and
 * `redirect()` (307) to what it returns; tests/studio-routes.test.ts feeds it every old URL shape
 * and every link the app still prints, and fails if any of them maps to nothing or to a page that
 * does not exist.
 *
 * Why most entries "stay": the plan's targets for them are canvas URLs (`/studio/sketch/me`,
 * `/studio/run/{id}`, the asset drawer …) and the canvas is not built in this step. Sending a
 * person to a canvas URL that does not exist yet would break the link, and sending them to Studio
 * home would drop the tool they asked for. So until each canvas step lands, the target is the page
 * that does the job today — which is the old URL itself — and `canvas` records where it will move
 * and which build step moves it. Only the two screens whose new home exists now redirect:
 * Videos (Studio home's Videos shelf) and the Editor's project list (Studio home's Projects shelf).
 *
 * `/studio` itself changed meaning (§9.1, adopted): it was Brand look and is now Studio home, with
 * Brand look one click away at `/studio/look` (the Channel look chip). An old bookmark therefore
 * "stays" and lands one click from where it used to.
 */

/** The build steps of STUDIO_IA.md §8 that will move a page onto the canvas. */
export type CanvasStep =
  /** Step 1 (rest of it): the `sketch` kind over creative_jobs and the asset drawer. */
  | "sketch"
  | "drawer"
  /** Step 2: the `run` kind from system_events plus the storyboard checkpoint. */
  | "run"
  /** Step 4: the `recipe` kind over saved workflows (0073). */
  | "recipe"
  /** Step 5: the `edit` kind; the editor's timeline becomes the shared one. */
  | "edit"
  /** Open decision (§9.2): whether Ads becomes a project kind. */
  | "ads";

export interface StudioRoute {
  /** The section path to open, with its query, and no channel: "/studio?shelf=videos". */
  href: string;
  /**
   * "redirect": the old URL answers 307 with `href`. "stays": `href` is the old URL itself, the
   * page that does the job today, and it is shown under the Studio rail entry.
   */
  kind: "redirect" | "stays";
  /** TODO(canvas): the plan's URL for this place, and the build step that will make it real. */
  canvas?: { step: CanvasStep; target: string };
}

/** The Studio home shelves (STUDIO_IA.md §5 "The new URLs"). */
export const STUDIO_SHELVES = ["projects", "videos"] as const;
export type StudioShelf = (typeof STUDIO_SHELVES)[number];

export function shelfFromQuery(v: unknown): StudioShelf {
  const s = Array.isArray(v) ? v[0] : v;
  return s === "videos" ? "videos" : "projects";
}

/**
 * The query key a shim adds so the landing page can say where the screen went ("Videos now lives
 * in Nightshift Studio"). It names a section, never carries user input.
 */
export const MOVED_PARAM = "moved";

/** A path segment that is an id: the routes below take uuids, YouTube ids and slugs, never a slash. */
const ID = "[^/?#]+";

type Rule = {
  pattern: RegExp;
  route: (m: RegExpMatchArray, query: URLSearchParams) => StudioRoute;
};

/** The old query, unchanged, after `base` (whose own keys win). Stable order: base keys first. */
function withQuery(base: string, query: URLSearchParams, own: Record<string, string> = {}): string {
  const q = new URLSearchParams(own);
  for (const [k, v] of query) if (!(k in own)) q.append(k, v);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/** The page as it was asked for: the old URL is the target. */
function stays(path: string, query: URLSearchParams, canvas?: StudioRoute["canvas"]): StudioRoute {
  return { href: withQuery(path, query), kind: "stays", ...(canvas ? { canvas } : {}) };
}

/** The first media desk tool (lib/creative/desks DESK_TOOLS), for the canvas target `?add=`. Kept literal: this module is pure. */
const DESK_FIRST_TOOL: Record<string, string> = { video: "t2v", image: "t2i", enhance: "upscale", voice: "tts" };

/** Where /create's query will send it on the canvas (§5's table), so the TODO names the exact place. */
function createCanvasTarget(query: URLSearchParams): string {
  const desk = query.get("desk");
  const tool = query.get("tool");
  if (desk === "youtube") return "/studio?new=topic";
  if (desk === "effects") return "/studio/sketch/me?drawer=effects";
  if (tool) return `/studio/sketch/me?add=${tool}`;
  if (desk && DESK_FIRST_TOOL[desk]) return `/studio/sketch/me?add=${DESK_FIRST_TOOL[desk]}`;
  return "/studio/sketch/me";
}

const RULES: Rule[] = [
  // The composer and its desks. TODO(canvas step "sketch"): /studio/sketch/me?add={tool}, prefill keys appended.
  { pattern: /^\/create$/, route: (_m, q) => stays("/create", q, { step: "sketch", target: createCanvasTarget(q) }) },
  // Videos: the Studio home's Videos shelf lists what /videos listed. A real move, so a real redirect.
  { pattern: /^\/videos$/, route: (_m, q) => ({ href: withQuery("/studio", q, { shelf: "videos" }), kind: "redirect" }) },
  // TODO(canvas step "run"): the `run` project's checkpoint node.
  {
    pattern: new RegExp(`^/videos/storyboard/(${ID})$`),
    route: (m, q) => stays(`/videos/storyboard/${m[1]}`, q, { step: "run", target: `/studio/run/${m[1]}?node=checkpoint` }),
  },
  // TODO(canvas step "run"): /studio/video/{id} resolves to the project that made it, with node=send.
  { pattern: new RegExp(`^/videos/(${ID})$`), route: (m, q) => stays(`/videos/${m[1]}`, q, { step: "run", target: `/studio/video/${m[1]}` }) },
  // Studio home. It was Brand look; Brand look is one click away now (the Channel look chip → /studio/look).
  { pattern: /^\/studio$/, route: (_m, q) => stays("/studio", q) },
  { pattern: /^\/studio\/look$/, route: (_m, q) => stays("/studio/look", q) },
  // The region editor (its flag, default off: it answers 404 then, as it does today). TODO(canvas step "sketch"): the Image node's Regions tab.
  { pattern: /^\/studio\/regions$/, route: (_m, q) => stays("/studio/regions", q, { step: "sketch", target: "/studio/sketch/me?add=edit&tab=regions" }) },
  // TODO(canvas step "drawer"): the Looks drawer tab (?look= for a picked style).
  {
    pattern: /^\/styles$/,
    route: (_m, q) => stays("/styles", q, { step: "drawer", target: q.get("style") ? `/studio?drawer=looks&look=${q.get("style")}` : "/studio?drawer=looks" }),
  },
  { pattern: /^\/presets$/, route: (_m, q) => stays("/presets", q, { step: "drawer", target: "/studio?drawer=looks&tab=presets" }) },
  { pattern: /^\/library$/, route: (_m, q) => stays("/library", q, { step: "drawer", target: "/studio?drawer=media" }) },
  // The Editor's project list: the Studio home's Projects shelf, editor kind. A real move.
  { pattern: /^\/editor$/, route: (_m, q) => ({ href: withQuery("/studio", q, { shelf: "projects", kind: "edit" }), kind: "redirect" }) },
  // TODO(canvas step "sketch"): the Image node's Edit tab.
  {
    pattern: new RegExp(`^/editor/image/(${ID})$`),
    route: (m, q) => stays(`/editor/image/${m[1]}`, q, { step: "sketch", target: `/studio/sketch/me?node=asset:${m[1]}&tab=edit` }),
  },
  // TODO(canvas step "edit"): the `edit` project on the timeline view.
  { pattern: new RegExp(`^/editor/(${ID})$`), route: (m, q) => stays(`/editor/${m[1]}`, q, { step: "edit", target: `/studio/edit/${m[1]}?view=timeline` }) },
  // TODO(canvas step "recipe"): saved workflows become recipes.
  { pattern: /^\/workflows$/, route: (_m, q) => stays("/workflows", q, { step: "recipe", target: "/studio?drawer=recipes" }) },
  {
    pattern: new RegExp(`^/workflows/runs/(${ID})$`),
    route: (m, q) => stays(`/workflows/runs/${m[1]}`, q, { step: "recipe", target: `/studio/recipe/{workflowId}?node=recipe&tab=runs&run=${m[1]}` }),
  },
  { pattern: new RegExp(`^/workflows/(${ID})$`), route: (m, q) => stays(`/workflows/${m[1]}`, q, { step: "recipe", target: `/studio/recipe/${m[1]}` }) },
  // TODO(canvas step "run"): the latest `run` project ("Autopilot has not run on this channel" when there is none).
  { pattern: /^\/pipeline$/, route: (_m, q) => stays("/pipeline", q, { step: "run", target: "/studio/run/latest" }) },
  // Behind their switches (off: 404, as today).
  { pattern: /^\/character-studio$/, route: (_m, q) => stays("/character-studio", q, { step: "sketch", target: "/studio/sketch/me?add=swap" }) },
  { pattern: /^\/ads$/, route: (_m, q) => stays("/ads", q, { step: "ads", target: "/ads" }) },
];

/**
 * The new place for an old creative URL, given as a section path with its query and no channel
 * ("/create?tool=t2v"). Null when the URL is not one of the creative screens (Billing, Inbox …):
 * those did not move. Never throws on junk.
 */
export function studioRoute(url: string): StudioRoute | null {
  const [rawPath, ...rest] = url.split("?");
  const path = (rawPath.split("#")[0] || "/").replace(/\/+$/, "") || "/";
  const query = new URLSearchParams(rest.join("?").split("#")[0] ?? "");
  for (const rule of RULES) {
    const m = path.match(rule.pattern);
    if (m) return rule.route(m, query);
  }
  return null;
}

/**
 * A shim's target: the section path to `redirect()` to, with the "moved" marker so the landing
 * page can show its one-line notice. `section` is the old path's first segment ("videos").
 */
export function redirectTarget(path: string, searchParams: Record<string, string | string[] | undefined>, section: string): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (k === MOVED_PARAM) continue;
    for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, one);
  }
  const s = q.toString();
  const route = studioRoute(s ? `${path}?${s}` : path);
  // A shim exists only for a "redirect" rule; anything else would loop, so it falls back to Studio home.
  const href = route && route.kind === "redirect" ? route.href : "/studio";
  return `${href}${href.includes("?") ? "&" : "?"}${MOVED_PARAM}=${encodeURIComponent(section)}`;
}
