/**
 * Every old creative URL, and every link the app still prints into the creative screens, lands on a
 * page that exists (docs/studio/STUDIO_IA.md §5, build step 1).
 *
 * What would break without this: a bookmark, an e-mail, a notification, the palette, a Library
 * "Use in Studio" link or the public site's "Use this prompt" sending someone to a 404 the day the
 * tools moved under Nightshift Studio; a redirect that points at another redirect (a loop); or a
 * redirect target that names a canvas URL before the canvas exists.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOVED_PARAM, ZOMBIE_SECTIONS, redirectTarget, shelfFromQuery, studioRoute, zombieRedirect } from "@/lib/studioRoutes";
import { STUDIO_HOUSED_KEYS, STUDIO_SCREENS, STUDIO_TILES, CUSTOMER_SIDEBAR, NAV_ITEMS, STUDIO_TOOLS, toolHref } from "@/lib/navigation";
import { DESKS, deskHref } from "@/lib/creative/desks";
import { toolHref as homeToolHref, runHandoffHref } from "@/lib/home";
import { EFFECTS, EFFECTS_DESK_SECTION, effectSection } from "@/lib/effects/catalog";
import { improveHref, IMPROVE_TOOLS } from "@/lib/creative/improve";
import { lookHref, starterHref, voiceHref } from "@/lib/presets";
import { linkFor } from "@/lib/models-discovery";
import { REGISTRY_CAPABILITIES } from "@/lib/models-discovery";
import { describeNotification, type InboxRow } from "@/lib/notifications";
import { promptHref, attachedHref } from "@/lib/site/prompt-link";
import { isSection } from "@/lib/channels";

const APP = path.join(__dirname, "..", "app", "(app)", "[channel]");
const UUID = "3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";

/** Is there a page.tsx for this section path ("/videos/abc")? Static segments first, then a `[param]` folder. */
function pageExists(sectionPath: string): boolean {
  const segs = sectionPath.split(/[?#]/)[0].split("/").filter(Boolean);
  let dir = APP;
  for (const seg of segs) {
    if (existsSync(path.join(dir, seg))) {
      dir = path.join(dir, seg);
      continue;
    }
    const dyn = readdirSync(dir, { withFileTypes: true }).find((d) => d.isDirectory() && /^\[[^.]+\]$/.test(d.name));
    if (!dyn) return false;
    dir = path.join(dir, dyn.name);
  }
  return existsSync(path.join(dir, "page.tsx"));
}

/** The channel-free section path of an app link ("/chronos/create?x" → "/create?x"); a bare section path is returned as is. */
function sectionOf(href: string): string {
  const [p, ...q] = href.split("?");
  const segs = p.split("/").filter(Boolean);
  const rest = segs.length > 0 && !isSection(segs[0]) ? segs.slice(1) : segs;
  return "/" + rest.join("/") + (q.length ? "?" + q.join("?") : "");
}

/** A link resolves when it is a creative URL with a target page, or a screen that did not move (it 404s nowhere new). */
function resolves(link: string): { ok: boolean; why: string } {
  const section = sectionOf(link.split("#")[0]);
  const route = studioRoute(section);
  if (!route) {
    const first = section.split(/[/?]/).filter(Boolean)[0] ?? "";
    const housed = STUDIO_SCREENS.includes("/" + first);
    // Not a creative screen: it did not move. A housed screen with no rule would be a gap in the map.
    return { ok: !housed && (first === "" || isSection(first)) && pageExists(section), why: `no rule for ${section}` };
  }
  if (!pageExists(route.href)) return { ok: false, why: `${section} → ${route.href}, which has no page` };
  if (route.kind === "redirect") {
    // One hop only: the target is a page that stays, never another redirect.
    const again = studioRoute(route.href);
    if (!again || again.kind !== "stays") return { ok: false, why: `${section} → ${route.href} redirects again` };
  }
  return { ok: true, why: "" };
}

// ── every old URL shape in STUDIO_IA.md §5 ────────────────────────────────────

const OLD_SHAPES = [
  "/create",
  ...STUDIO_TOOLS.map((t) => `/create?tool=${t}`),
  "/create?desk=image",
  "/create?desk=video",
  "/create?desk=enhance",
  "/create?desk=voice",
  "/create?desk=effects&effect=life",
  "/create?desk=youtube&topic=space&length=300&lang=uz",
  "/create?model=m1&style=s1&prompt=hello&improve=1&attach=n1",
  "/create/projects",
  `/create/projects/${UUID}`,
  "/videos",
  `/videos/${UUID}`,
  "/videos/dQw4w9WgXcQ",
  `/videos/storyboard/${UUID}`,
  "/studio",
  "/studio/look",
  "/studio/regions",
  "/styles",
  "/styles?style=noir",
  "/presets",
  "/library",
  "/library?folder=abc",
  "/editor",
  `/editor/${UUID}`,
  `/editor/image/${UUID}`,
  "/workflows",
  `/workflows/${UUID}`,
  `/workflows/runs/${UUID}`,
  "/pipeline",
  "/character-studio",
  "/ads",
];

describe("studioRoute: every old creative URL maps somewhere real", () => {
  for (const url of OLD_SHAPES) {
    it(url, () => {
      expect(studioRoute(url), url).not.toBeNull();
      const r = resolves(url);
      expect(r.ok, r.why).toBe(true);
    });
  }

  it("covers every housed screen and every Studio home tile", () => {
    for (const i of NAV_ITEMS.filter((n) => STUDIO_HOUSED_KEYS.includes(n.key))) expect(studioRoute(i.href), i.href).not.toBeNull();
    for (const tile of STUDIO_TILES) expect(resolves(tile.href).ok, tile.href).toBe(true);
  });

  it("redirects only what has a new home today, and names the canvas step for everything else", () => {
    const redirects = OLD_SHAPES.filter((u) => studioRoute(u)?.kind === "redirect");
    expect(redirects).toEqual(["/create/projects", "/videos", "/editor", "/workflows"]);
    expect(studioRoute("/workflows")?.href).toBe("/studio");
    expect(studioRoute("/create/projects")?.href).toBe("/studio?shelf=projects");
    expect(studioRoute(`/create/projects/${UUID}`)?.canvas).toEqual({ step: "film", target: `/studio/film/${UUID}` });
    expect(studioRoute("/videos")?.href).toBe("/studio?shelf=videos");
    expect(studioRoute("/editor")?.href).toBe("/studio?shelf=projects&kind=edit");
    // Not built yet, so nothing may point at a canvas URL: every "stays" target is its own old URL.
    for (const u of OLD_SHAPES) {
      const r = studioRoute(u)!;
      expect(r.href, u).not.toMatch(/^\/studio\/(sketch|run|film|recipe|edit|video)\//);
      if (r.kind === "stays") expect(r.href, u).toBe(u);
    }
    expect(studioRoute("/create?tool=t2v")?.canvas).toEqual({ step: "sketch", target: "/studio/sketch/me?add=t2v" });
    expect(studioRoute("/create?desk=voice")?.canvas?.target).toBe("/studio/sketch/me?add=tts");
    expect(studioRoute(`/videos/storyboard/${UUID}`)?.canvas).toEqual({ step: "run", target: `/studio/run/${UUID}?node=checkpoint` });
    expect(studioRoute("/pipeline")?.canvas?.step).toBe("run");
    expect(studioRoute(`/workflows/${UUID}`)?.canvas?.step).toBe("recipe");
    expect(studioRoute(`/editor/${UUID}`)?.canvas?.step).toBe("edit");
  });

  it("carries the query over unchanged (the prefill keys a link put there)", () => {
    expect(studioRoute("/create?tool=t2v&model=m1&prompt=a%20b")?.href).toBe("/create?tool=t2v&model=m1&prompt=a+b");
    expect(studioRoute("/videos?x=1")?.href).toBe("/studio?shelf=videos&x=1");
    // The target's own key wins over a stale one in the old query.
    expect(studioRoute("/videos?shelf=projects")?.href).toBe("/studio?shelf=videos");
  });

  it("leaves screens that did not move alone, and never throws on junk", () => {
    for (const u of ["/billing", "/inbox", "/home", "/channels/new", "/analytics"]) expect(studioRoute(u), u).toBeNull();
    for (const u of ["", "?", "#", "//", "/videos/", "/create/", "/%E0%A4%A", "/videos/a/b/c"]) expect(() => studioRoute(u)).not.toThrow();
    // A trailing slash is the same page.
    expect(studioRoute("/videos/")?.kind).toBe("redirect");
  });
});

// ── every link the app still prints ────────────────────────────────────────────

function printedLinks(): string[] {
  const links: string[] = [];
  // The sidebar's old tool rows (kept for the canvas's Add node menu) and Home's quick tools.
  links.push(...STUDIO_TOOLS.map(toolHref), ...CUSTOMER_SIDEBAR.tools.map((t) => t.href), ...STUDIO_TOOLS.map((t) => homeToolHref(t)));
  // The sidebar now: Home, Studio, Inbox, Channels and the foot.
  links.push(CUSTOMER_SIDEBAR.home.href, ...CUSTOMER_SIDEBAR.work.map((i) => i.href), ...CUSTOMER_SIDEBAR.footer.map((i) => i.href));
  // The desks (Studio home's Create tile, the desk bar, the overview's keys).
  links.push(...DESKS.map(deskHref));
  // Effects, presets, the Style Library, the Models catalog, the Library's Improve panel.
  links.push(EFFECTS_DESK_SECTION, ...EFFECTS.map(effectSection));
  links.push(starterHref("chronos", { id: "cutout", capability: "t2i" }), voiceHref("chronos", "v1"), lookHref("chronos", "noir"));
  for (const cap of REGISTRY_CAPABILITIES) {
    const l = linkFor(cap, "model-1");
    if (l.kind !== "none") links.push(l.href);
  }
  for (const tools of Object.values(IMPROVE_TOOLS)) for (const tool of tools) {
    const h = improveHref(tool, UUID, UUID, { model: "model-1", prompt: "words" });
    if (h) links.push(h);
  }
  // Home's run composer hands off to /create with the topic.
  links.push(runHandoffHref("chronos", { topic: "Space", seconds: 300, language: "uz" } as never));
  // Notifications: every kind, with and without its id.
  const kinds: { kind: InboxRow["kind"]; data: Record<string, unknown> }[] = [
    { kind: "creative_job_completed", data: { capability: "t2i" } },
    { kind: "creative_job_completed", data: { capability: "describe" } },
    { kind: "creative_job_completed", data: { capability: "captions" } },
    { kind: "creative_job_failed", data: { capability: "t2v" } },
    { kind: "storyboard_ready", data: { storyboard_id: UUID, channel_id: "chronos" } },
    { kind: "storyboard_ready", data: {} },
    { kind: "video_ready", data: { video_id: "dQw4w9WgXcQ", channel_id: "chronos" } },
    { kind: "video_ready", data: {} },
    { kind: "editor_export_done", data: { project_id: UUID } },
    { kind: "editor_export_done", data: {} },
    { kind: "credits_low", data: { available: 3 } },
  ];
  for (const k of kinds) {
    const v = describeNotification({ id: "n", org_id: "o", ref: "r", created_at: "2026-11-14T00:00:00Z", read_at: null, ...k });
    links.push(v.section);
    if (v.another) links.push(v.another);
  }
  // The palette's places (components/CommandPalette.tsx NAV), read from the file so a new entry is checked too.
  const palette = readFileSync(path.join(__dirname, "..", "components", "CommandPalette.tsx"), "utf8");
  links.push(...Array.from(palette.matchAll(/\{ href: "(\/[^"]+)", key:/g), (m) => m[1]));
  // The palette's video results and event rows.
  links.push(`/videos/dQw4w9WgXcQ`);
  // The public site's "Use this prompt" (signed in, and through sign-up: the `next` it carries).
  links.push(promptHref("t2v", "a fox at dawn", true)!, promptHref("t2i", "a fox at dawn", true)!, attachedHref("a fox", true, "n1"));
  for (const signedOut of [promptHref("t2v", "a fox at dawn", false)!, attachedHref("a fox", false, "n1")]) {
    const next = new URL(signedOut, "https://x").searchParams.get("next");
    expect(next, signedOut).toBeTruthy();
    links.push(next!);
  }
  // The e-mails (modules/email_notify.py): "open" and "make another" links, checked against the file below.
  links.push("/home", "/create", "/chronos/create", "/library", "/organization", "/chronos/videos/dQw4w9WgXcQ");
  return links;
}

describe("every link the app still prints lands on a page", () => {
  it("toolHref, deskHref, palette, notifications, e-mails and the public site's prompt links", () => {
    const links = printedLinks();
    expect(links.length).toBeGreaterThan(60);
    const broken = links.map((l) => ({ l, ...resolves(l) })).filter((r) => !r.ok);
    expect(broken, JSON.stringify(broken, null, 2)).toEqual([]);
  });

  it("the e-mail links above are the ones modules/email_notify.py still builds", () => {
    const py = readFileSync(path.join(__dirname, "..", "..", "modules", "email_notify.py"), "utf8");
    for (const s of ['origin + "/home"', 'origin + "/create"', 'return "/library"', 'origin + "/organization"', "/videos/{quote(video", "/create\""]) {
      expect(py, s).toContain(s);
    }
  });
});

// ── the shims ──────────────────────────────────────────────────────────────────

describe("redirectTarget: what a shim sends", () => {
  it("adds the moved marker, keeps the query, and drops a stale marker", () => {
    expect(redirectTarget("/videos", {}, "videos")).toBe(`/studio?shelf=videos&${MOVED_PARAM}=videos`);
    expect(redirectTarget("/videos", { a: "1", moved: "x" }, "videos")).toBe(`/studio?shelf=videos&a=1&${MOVED_PARAM}=videos`);
    expect(redirectTarget("/editor", { b: ["1", "2"] }, "editor")).toBe(`/studio?shelf=projects&kind=edit&b=1&b=2&${MOVED_PARAM}=editor`);
  });

  it("never loops: a path with no redirect rule falls back to Studio home", () => {
    expect(redirectTarget("/create", {}, "create")).toBe(`/studio?${MOVED_PARAM}=create`);
  });

  it("reads the shelf from the query, defaulting to Projects", () => {
    expect(shelfFromQuery("videos")).toBe("videos");
    expect(shelfFromQuery(["videos"])).toBe("videos");
    expect(shelfFromQuery("anything")).toBe("projects");
    expect(shelfFromQuery(undefined)).toBe("projects");
  });
});

const { redirect } = vi.hoisted(() => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/channels-path-server", () => ({ getChannelPath: async () => (p: string) => `/chronos${p}` }));

describe("the old pages are server-side shims that redirect once, on the same channel", () => {
  beforeEach(() => {
    redirect.mockClear();
  });

  for (const [page, want] of [
    ["videos", "/chronos/studio?shelf=videos&tab=1&moved=videos"],
    ["editor", "/chronos/studio?shelf=projects&kind=edit&tab=1&moved=editor"],
  ] as const) {
    it(`/${page}`, async () => {
      const mod = await import(/* @vite-ignore */ `../app/(app)/[channel]/${page}/page`);
      await expect(mod.default({ searchParams: Promise.resolve({ tab: "1" }) })).rejects.toThrow("NEXT_REDIRECT");
      expect(redirect).toHaveBeenCalledWith(want);
    });
  }

  it("/workflows no longer draws the old list under a 'moved' line: it redirects to Studio home, query kept, no notice", async () => {
    const mod = await import("../app/(app)/[channel]/workflows/page");
    await expect(mod.default({ searchParams: Promise.resolve({ tab: "1" }) })).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/chronos/studio?tab=1");
  });
});

describe("zombieRedirect: the middleware answers the moved list screens before the shell streams", () => {
  it("sends each zombie list to its Studio place on the same channel, with no 'moved' notice", () => {
    expect(ZOMBIE_SECTIONS).toEqual(["videos", "editor", "workflows"]);
    expect(zombieRedirect("/chronos/videos", "")).toBe("/chronos/studio?shelf=videos");
    expect(zombieRedirect("/chronos/editor", "")).toBe("/chronos/studio?shelf=projects&kind=edit");
    expect(zombieRedirect("/all-channels/workflows", "")).toBe("/all-channels/studio");
    expect(zombieRedirect("/chronos/videos/", "?a=1&moved=videos")).toBe("/chronos/studio?shelf=videos&a=1");
  });

  it("leaves a video's, a project's and a workflow's own pages, and every other screen, alone", () => {
    for (const p of [`/chronos/videos/${UUID}`, `/chronos/videos/storyboard/${UUID}`, `/chronos/editor/${UUID}`, `/chronos/editor/image/${UUID}`,
      `/chronos/workflows/${UUID}`, `/chronos/workflows/runs/${UUID}`, "/chronos/studio", "/chronos/create/projects", "/chronos/character-studio",
      "/videos", "/api/videos", "/chronos/library"]) {
      expect(zombieRedirect(p, ""), p).toBeNull();
    }
  });

  it("is called by middleware.ts only after the auth and second-factor gates (it decides nothing about access)", () => {
    const src = readFileSync(path.join(__dirname, "..", "middleware.ts"), "utf8");
    const at = src.indexOf("zombieRedirect(request");
    expect(at).toBeGreaterThan(0);
    for (const gate of ["supabase.auth.getUser()", "mfaAction === \"challenge\"", "channelRedirect(request)"]) {
      expect(src.indexOf(gate), gate).toBeGreaterThan(0);
      expect(src.indexOf(gate), gate).toBeLessThan(at);
    }
  });
});
