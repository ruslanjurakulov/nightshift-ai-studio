// @vitest-environment jsdom
/**
 * Where Studio → Projects is listed, and when (NIGHTSHIFT_FILM_STUDIO). What would break without these: a Studio section that links
 * to a 404; the unfinished section shown to customers while the switch says `admins`; the switch read in the browser (a NEXT_PUBLIC
 * value compiled in at build time); and the pages reading the workspace or the database while the switch is off.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create/projects",
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/channels-path-server", () => ({ getChannelPath: async () => (p: string) => `/chronos${p}` }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));
vi.mock("@/lib/config", () => ({ isSupabaseConfigured: true, SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "x" }));
vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("../lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});
const h = vi.hoisted(() => ({ org: vi.fn(), client: vi.fn(), admin: vi.fn(), list: vi.fn(), ctx: vi.fn() }));
vi.mock("@/lib/orgs-server", () => ({ getOrgContext: h.org }));
vi.mock("@/lib/supabase/server", () => ({ createClient: h.client, getUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/auth/org-roles", () => ({ isPlatformAdmin: h.admin }));
vi.mock("@/lib/channels-server", () => ({ getChannelContext: h.ctx }));

const { I18nProvider } = await import("../lib/i18n/context");
const { ShellProvider } = await import("../components/shell/ShellContext");
const { DeskBar } = await import("../components/studio/Desks");
const { STUDIO_PROJECTS } = await import("../lib/navigation");
const { UNKNOWN_TOOLS } = await import("../lib/tool-availability");

const shell = (ui: ReactNode, filmStudio?: boolean) => (
  <I18nProvider locale="en">
    <ShellProvider operator={false} tools={UNKNOWN_TOOLS} features={{ adsFactory: false, characterStudio: false, filmStudio }}>
      {ui}
    </ShellProvider>
  </I18nProvider>
);

function flatten(node: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
  else if (node && typeof node === "object" && "props" in (node as object)) {
    out.push(node as ReactElement);
    flatten((node as ReactElement<{ children?: unknown }>).props.children, out);
  }
  return out;
}

beforeEach(() => {
  h.org.mockReset().mockResolvedValue({ supported: true, orgs: [], current: { id: "0a000000-0000-4000-8000-00000000000a", role: "viewer" } });
  h.client.mockReset().mockResolvedValue({ from: () => ({ select: () => { throw new Error("read"); } }) });
  h.admin.mockReset().mockResolvedValue(false);
  h.ctx.mockReset().mockResolvedValue({ selection: "all", channels: [] });
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("the Studio section", () => {
  it("is listed beside the desks only while the layout says so, under the Studio's own address", () => {
    render(shell(<DeskBar current="video" />));
    expect(screen.queryByText("Projects")).toBeNull();
    cleanup();
    render(shell(<DeskBar current="projects" />, true));
    const link = screen.getByText("Projects").closest("a")!;
    expect(link.getAttribute("href")).toBe(`/chronos${STUDIO_PROJECTS}`);
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Scene by scene")).toBeTruthy();
    expect(STUDIO_PROJECTS).toBe("/create/projects");
  });

  it("the switch is read on the server only", () => {
    const root = join(__dirname, "..");
    for (const f of ["components/studio/Desks.tsx", "components/shell/CustomerSidebar.tsx", "components/studio/StudioHome.tsx", "components/films/FilmCanvas.tsx", "components/films/FilmList.tsx"]) {
      const src = readFileSync(join(root, f), "utf8");
      expect(src, f).not.toMatch(/process\.env|NEXT_PUBLIC_[A-Z_]*FILM/);
    }
    const layout = readFileSync(join(root, "app/(app)/layout.tsx"), "utf8");
    expect(layout).toContain("filmStudio: filmStudioListed(filmMode, frame, filmOrgOn)");
    // The roll-up asks about any of the viewer's workspaces; a channel view about the open one.
    expect(layout).toContain("filmStudioViewerOn(filmMode, !isScoped(selection))");
  });
});

const ORG_A = "0a000000-0000-4000-8000-00000000000a";
const ORG_B = "0b000000-0000-4000-8000-00000000000b";
/** A member client whose org_film_settings read answers `answer` (rows, a database error, or a throw), and records what was asked. */
function switchClient(answer: () => unknown) {
  const asked: string[][] = [];
  const client = {
    from: (table: string) => {
      if (table !== "org_film_settings") throw new Error(`unexpected table ${table}`);
      return {
        select: (cols: string) => {
          expect(cols).toBe("org_id, film_studio_enabled");
          return {
            in: async (col: string, ids: string[]) => {
              expect(col).toBe("org_id");
              asked.push(ids);
              const a = answer();
              if (a instanceof Error) throw a;
              return a;
            },
          };
        },
      };
    },
  };
  return { client, asked };
}
const rows = (...r: Array<[string, boolean]>) => ({ data: r.map(([org_id, film_studio_enabled]) => ({ org_id, film_studio_enabled })), error: null });

describe("the workspace switch under `on` (org_film_settings, 0198)", () => {
  beforeEach(() => {
    vi.stubEnv("NIGHTSHIFT_FILM_STUDIO", "on");
    h.org.mockResolvedValue({
      supported: true,
      orgs: [],
      switchable: [{ id: ORG_A }, { id: ORG_B }],
      current: { id: ORG_A, role: "viewer" },
    });
  });

  it("a workspace that is off: no nav entry, and the pages are a 404", async () => {
    const { filmStudioListed, filmStudioViewerOn } = await import("../lib/server/films");
    const { client } = switchClient(() => rows([ORG_A, false]));
    h.client.mockResolvedValue(client);
    expect(filmStudioListed("on", true, await filmStudioViewerOn("on", false))).toBe(false);
    const { default: List } = await import("../app/(app)/[channel]/create/projects/page");
    const { default: Canvas } = await import("../app/(app)/[channel]/create/projects/[id]/page");
    await expect(List({})).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(Canvas({ params: Promise.resolve({ id: "x" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("a workspace that is on: listed, and the page opens", async () => {
    const { filmStudioListed, filmStudioViewerOn, filmStudioOpen } = await import("../lib/server/films");
    const { client, asked } = switchClient(() => rows([ORG_A, true]));
    h.client.mockResolvedValue(client);
    expect(filmStudioListed("on", false, await filmStudioViewerOn("on", false))).toBe(true);
    expect(await filmStudioOpen()).toBe(true);
    // The open workspace only, through the member's own client.
    expect(asked).toEqual([[ORG_A], [ORG_A]]);
    const { default: List } = await import("../app/(app)/[channel]/create/projects/page");
    await expect(List({})).rejects.toThrow("NEXT_REDIRECT /chronos/studio?shelf=projects&moved=projects");
  });

  it("a workspace never switched (no row) is hidden", async () => {
    const { filmStudioViewerOn, filmStudioOpen } = await import("../lib/server/films");
    h.client.mockResolvedValue(switchClient(() => rows()).client);
    expect(await filmStudioViewerOn("on", false)).toBe(false);
    expect(await filmStudioOpen()).toBe(false);
  });

  it("a read that fails is hidden and closed, with one log line naming the workspace and the code; never open", async () => {
    const { filmStudioViewerOn, filmStudioOpen } = await import("../lib/server/films");
    const { FilmProjectsShelf } = await import("../components/studio-hub/FilmProjectsShelf");
    const { default: List } = await import("../app/(app)/[channel]/create/projects/page");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [answer, code] of [
        [() => ({ data: null, error: { code: "PGRST301", message: "JWT expired" } }), "PGRST301"],
        [() => new Error("socket hang up"), "threw"],
        [() => ({ data: null, error: null }), "unexpected_shape"],
      ] as Array<[() => unknown, string]>) {
        h.client.mockResolvedValue(switchClient(answer).client);
        for (const check of [() => filmStudioViewerOn("on", false), () => filmStudioOpen()]) {
          log.mockClear();
          expect(await check()).toBe(false);
          expect(log).toHaveBeenCalledOnce();
          const line = log.mock.calls[0].map(String).join(" ");
          expect(line).toContain(ORG_A);
          expect(line).toContain(code);
          expect(line).not.toMatch(/JWT expired|socket hang up/);
        }
        await expect(List({})).rejects.toThrow("NEXT_NOT_FOUND");
        expect(await FilmProjectsShelf()).toBeNull();
      }
      // No client at all (not configured) is not a yes either.
      h.client.mockResolvedValue(null);
      log.mockClear();
      expect(await filmStudioOpen()).toBe(false);
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it("the every-channel roll-up: listed when any of the viewer's own workspaces is on, not when none is", async () => {
    const { filmStudioListed, filmStudioViewerOn } = await import("../lib/server/films");
    let s = switchClient(() => rows([ORG_A, false], [ORG_B, true]));
    h.client.mockResolvedValue(s.client);
    expect(filmStudioListed("on", false, await filmStudioViewerOn("on", true))).toBe(true);
    expect(s.asked).toEqual([[ORG_A, ORG_B]]);
    s = switchClient(() => rows([ORG_A, false], [ORG_B, false]));
    h.client.mockResolvedValue(s.client);
    expect(filmStudioListed("on", false, await filmStudioViewerOn("on", true))).toBe(false);
    s = switchClient(() => rows());
    h.client.mockResolvedValue(s.client);
    expect(await filmStudioViewerOn("on", true)).toBe(false);
  });

  it("`admins` and `off` read no workspace switch: an admin sees it, anyone else does not", async () => {
    const { filmStudioListed, filmStudioViewerOn, filmStudioOpen } = await import("../lib/server/films");
    const s = switchClient(() => rows([ORG_A, false]));
    h.client.mockResolvedValue(s.client);
    expect(await filmStudioViewerOn("admins", false)).toBe(false);
    expect(await filmStudioViewerOn("off", true)).toBe(false);
    expect(filmStudioListed("admins", true, false)).toBe(true);
    expect(filmStudioListed("admins", false, true)).toBe(false);
    expect(filmStudioListed("off", true, true)).toBe(false);
    expect(await filmStudioOpen("admins")).toBe(false);
    h.admin.mockResolvedValue(true);
    expect(await filmStudioOpen("admins")).toBe(true);
    expect(await filmStudioOpen("off")).toBe(false);
    expect(s.asked).toEqual([]);
    expect(h.org).not.toHaveBeenCalled();
  });
});

describe("the pages", () => {
  it("are a 404 while the switch is off, and read nothing", async () => {
    const { default: List } = await import("../app/(app)/[channel]/create/projects/page");
    const { default: Canvas } = await import("../app/(app)/[channel]/create/projects/[id]/page");
    for (const v of ["", "off", "enabled"]) {
      vi.stubEnv("NIGHTSHIFT_FILM_STUDIO", v);
      await expect(List({})).rejects.toThrow("NEXT_NOT_FOUND");
      await expect(Canvas({ params: Promise.resolve({ id: "x" }) })).rejects.toThrow("NEXT_NOT_FOUND");
    }
    expect(h.org).not.toHaveBeenCalled();
    expect(h.client).not.toHaveBeenCalled();
  });

  it("`admins`: a 404 for anyone but a platform admin; for an admin the list is the Studio home's Projects shelf", async () => {
    vi.stubEnv("NIGHTSHIFT_FILM_STUDIO", "admins");
    const { default: List } = await import("../app/(app)/[channel]/create/projects/page");
    const { FilmProjectsShelf } = await import("../components/studio-hub/FilmProjectsShelf");
    await expect(List({})).rejects.toThrow("NEXT_NOT_FOUND");
    // Off for this viewer, the shelf draws nothing and reads nothing either.
    expect(await FilmProjectsShelf()).toBeNull();
    expect(h.org).not.toHaveBeenCalled();
    h.admin.mockResolvedValue(true);
    // The old list URL now redirects (once, on the same channel) to the shelf that lists the projects.
    await expect(List({})).rejects.toThrow("NEXT_REDIRECT /chronos/studio?shelf=projects&moved=projects");
    expect(h.org).not.toHaveBeenCalled();
    h.client.mockResolvedValue({
      from: () => {
        const q = { eq: () => q, neq: () => q, order: () => q, limit: async () => ({ data: [], error: null }) };
        return { select: () => q };
      },
    });
    const tree = flatten(await FilmProjectsShelf());
    const list = tree.find((n) => (n.props as { initial?: unknown }).initial);
    // A viewer gets the list without the button: presentation only, the database checks the role again.
    expect(list?.props).toMatchObject({ initial: { state: "ok", films: [] }, canEdit: false, channel: null });
  });
});
