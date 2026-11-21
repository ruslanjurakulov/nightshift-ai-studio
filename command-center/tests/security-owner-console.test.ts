import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Breach, commit 8f55920a (account switcher + Owner Console at /owner). The question: can a customer, an admin who is not
 * the platform owner, a signed-out visitor, or anyone holding a hand-set `ns_owner_mode` cookie reach an Owner Console page,
 * owner data, or the Owner account?
 *
 * What would break without these:
 * - OC-1 (FAILING until fixed): every /owner page relies on app/owner/layout.tsx alone ("The layout has already confirmed
 *   the platform owner"). Next renders a page's RSC payload independently of its layout: on `next dev` (Next 15.5) a plain
 *   GET /owner/revenue answers 404 yet the HTML's flight data carries the page's title, subtitle and tool links, and an
 *   `RSC: 1` request with a forged `Next-Router-State-Tree` claiming the /owner layout is already mounted answers 200 with
 *   the page and never runs the layout at all. Today the pages hold only labels and links; the day S8 puts revenue, users
 *   or provider spend in them, a customer reads it. Each page must refuse a non-owner by itself (BR-H-001).
 * - OC-2 (FAILING until fixed): when the role lookup errors, the layout decides the second factor as for a customer
 *   (adminHint = false) even after the database said "owner"; an owner with no authenticator in `enforce` gets the console
 *   instead of being sent to enrol.
 * - The rest are refusals that held and must keep holding.
 */

vi.mock("server-only", () => ({}));

type User = { id: string; email?: string; factors?: Array<{ status: string; factor_type: string }> } | null;

const s = vi.hoisted(() => ({
  configured: true,
  user: null as User,
  /** is_platform_admin: true / false / "error" */
  admin: false as boolean | "error",
  /** owner_analytics_is_owner: true / false / "error" / "missing" */
  owner: false as boolean | "error" | "missing",
  cookie: undefined as string | undefined,
  aal: "aal2" as string | null,
  mfaMode: "enforce" as "off" | "warn" | "enforce",
  path: "/owner" as string | null,
}));

vi.mock("@/lib/config", () => ({
  SUPABASE_URL: "https://lab.supabase.test",
  SUPABASE_ANON_KEY: "anon",
  get isSupabaseConfigured() {
    return s.configured;
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/owner",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(s.path ? { "x-nightshift-path": s.path } : {}),
  cookies: async () => ({
    get: (name: string) => (name === "ns_owner_mode" && s.cookie !== undefined ? { name, value: s.cookie } : undefined),
    getAll: () => (s.cookie !== undefined ? [{ name: "ns_owner_mode", value: s.cookie }] : []),
    set: () => undefined,
  }),
}));

function rpcAnswer(name: string) {
  if (name === "is_platform_admin") {
    return s.admin === "error" ? { data: null, error: { code: "08006", message: "connection lost" } } : { data: s.admin, error: null };
  }
  if (name === "owner_analytics_is_owner") {
    if (s.owner === "missing") return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    if (s.owner === "error") return { data: null, error: { code: "08006", message: "connection lost" } };
    return { data: s.owner, error: null };
  }
  return { data: null, error: { code: "42501", message: "denied" } };
}

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => s.user,
  createClient: async () => ({ rpc: async (name: string) => rpcAnswer(name) }),
}));

vi.mock("@/lib/orgs-server", () => ({
  getOrgContext: async () => ({ supported: true, orgs: [], switchable: [], current: { id: "org-1", role: "owner" } }),
}));

vi.mock("@/lib/channels-server", () => ({ isChannelInCurrentOrg: async () => true }));

vi.mock("@/lib/security/admin-mfa-server", () => ({
  adminMfaMode: () => s.mfaMode,
  readMfaState: async (user: User) =>
    user
      ? {
          userId: user.id,
          aal: s.aal,
          hasVerifiedFactor: (user.factors ?? []).some((f) => f.status === "verified"),
          lastFactorAt: null,
        }
      : null,
  logPasswordOnlyAdmin: () => undefined,
}));

vi.mock("@/lib/i18n/server", async () => {
  const { en } = await import("@/lib/i18n/en");
  return { getDictionary: async () => ({ locale: "en", t: en }), getLocale: async () => "en" };
});

const CUSTOMER: User = { id: "cust-1", email: "customer@lab.test", factors: [] };
const ADMIN: User = { id: "admin-1", email: "admin@lab.test", factors: [{ status: "verified", factor_type: "totp" }] };
const OWNER: User = { id: "owner-1", email: "owner@lab.test", factors: [{ status: "verified", factor_type: "totp" }] };

function asCustomer() {
  s.user = CUSTOMER;
  s.admin = false;
  s.owner = false;
}
function asAdmin() {
  s.user = ADMIN;
  s.admin = true;
  s.owner = false;
}
function asOwner() {
  s.user = OWNER;
  s.admin = true;
  s.owner = true;
}

beforeEach(() => {
  vi.resetModules();
  s.configured = true;
  s.user = null;
  s.admin = false;
  s.owner = false;
  s.cookie = undefined;
  s.aal = "aal2";
  s.mfaMode = "enforce";
  s.path = "/owner";
});

const ROOT = join(__dirname, "..");
const OWNER_DIR = join(ROOT, "app", "owner");

function ownerPages(dir = OWNER_DIR): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return ownerPages(p);
    return name === "page.tsx" ? [relative(ROOT, p)] : [];
  });
}

/** Render a server component one level: what it returns, or the Next control-flow error it throws. */
async function outcome(fn: () => unknown): Promise<string> {
  try {
    await fn();
    return "rendered";
  } catch (e) {
    const m = (e as Error).message;
    if (m === "NEXT_NOT_FOUND") return "404";
    if (m.startsWith("NEXT_REDIRECT:")) return m.slice("NEXT_REDIRECT:".length);
    throw e;
  }
}

const loadLayout = async () => (await import("../app/owner/layout")).default as (p: { children: unknown }) => unknown;

// ─────────────────────────────────────────────────────────────────────────────
// OC-1: the pages are not guarded on their own
// ─────────────────────────────────────────────────────────────────────────────

describe("OC-1: an Owner Console page refuses a non-owner by itself, not only through its layout", () => {
  const pages = ownerPages();

  it("finds the seven console pages", () => {
    expect(pages.length).toBe(7);
  });

  // Next renders a segment's page without running the layout above it (a soft navigation whose router state tree already
  // holds /owner, or a forged Next-Router-State-Tree header), and even when the layout throws notFound() the page's own
  // RSC output is in the flight data. So the layout's 404 is not a lock on the page.
  it.each(pages)("%s answers the 404 to a signed-in customer", async (file) => {
    asCustomer();
    s.cookie = "on";
    const Page = (await import(`../${file}`)).default as () => unknown;
    expect(await outcome(() => Page())).toBe("404");
  });

  it.each(pages)("%s answers the 404 to an admin who is not the platform owner", async (file) => {
    asAdmin();
    s.cookie = "on";
    const Page = (await import(`../${file}`)).default as () => unknown;
    expect(await outcome(() => Page())).toBe("404");
  });

  it.each(pages)("%s does not render for a signed-out visitor", async (file) => {
    const Page = (await import(`../${file}`)).default as () => unknown;
    expect(await outcome(() => Page())).not.toBe("rendered");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OC-2: the second factor when the role lookup fails
// ─────────────────────────────────────────────────────────────────────────────

describe("OC-2: the console's second factor does not depend on the role lookup succeeding", () => {
  it("an owner with no authenticator, under enforce, is sent to enrol even when is_platform_admin errored", async () => {
    // The database answered "owner" (owner_analytics_is_owner), so this IS the owner: the factor rule for an admin applies.
    s.user = { id: "owner-1", email: "owner@lab.test", factors: [] };
    s.admin = "error";
    s.owner = true;
    s.aal = "aal1";
    const Layout = await loadLayout();
    expect(await outcome(() => Layout({ children: null }))).toBe("/security");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Refusals that held (regression)
// ─────────────────────────────────────────────────────────────────────────────

describe("the /owner layout: only the platform owner gets the console", () => {
  it("signed out goes to sign-in (and back to /owner only)", async () => {
    const Layout = await loadLayout();
    expect(await outcome(() => Layout({ children: null }))).toBe("/login?next=%2Fowner");
  });

  it("a customer gets the public 404, whatever ns_owner_mode says", async () => {
    asCustomer();
    for (const cookie of [undefined, "on", "off", "ON", "true", "1", ""]) {
      s.cookie = cookie;
      vi.resetModules();
      const Layout = await loadLayout();
      expect(await outcome(() => Layout({ children: null })), String(cookie)).toBe("404");
    }
  });

  it("a customer whose owner check errors or is missing still gets the 404, never the operator's notice", async () => {
    asCustomer();
    for (const owner of ["error", "missing"] as const) {
      s.owner = owner;
      vi.resetModules();
      const Layout = await loadLayout();
      expect(await outcome(() => Layout({ children: null })), owner).toBe("404");
    }
  });

  it("an admin who is not the owner gets the 404, with the cookie on or off", async () => {
    asAdmin();
    for (const cookie of [undefined, "on", "off"]) {
      s.cookie = cookie;
      vi.resetModules();
      const Layout = await loadLayout();
      expect(await outcome(() => Layout({ children: null })), String(cookie)).toBe("404");
    }
  });

  it("an admin whose owner check failed gets a 'could not check' notice, not the console's shell", async () => {
    asAdmin();
    s.owner = "error";
    const Layout = await loadLayout();
    const el = (await Layout({ children: "SECRET-CHILD" })) as { props: { children: { type: string } } };
    expect(JSON.stringify(el)).not.toContain("SECRET-CHILD");
  });

  it("a password-only session of the owner (factor enrolled) is sent to the code first", async () => {
    asOwner();
    s.aal = "aal1";
    s.path = "/owner/revenue";
    const Layout = await loadLayout();
    expect(await outcome(() => Layout({ children: null }))).toBe("/login/verify?next=%2Fowner%2Frevenue");
  });

  it("the mfa return path is the middleware's header; a hostile one still lands on the verify page", async () => {
    asOwner();
    s.aal = "aal1";
    s.path = "https://evil.example/";
    const Layout = await loadLayout();
    const to = await outcome(() => Layout({ children: null }));
    expect(to.startsWith("/login/verify?next=")).toBe(true);
  });

  it("no Supabase is the 404, never an open console", async () => {
    s.configured = false;
    const Layout = await loadLayout();
    expect(await outcome(() => Layout({ children: null }))).toBe("404");
  });

  it("the owner, with the second factor, gets the console", async () => {
    asOwner();
    const Layout = await loadLayout();
    expect(await outcome(() => Layout({ children: null }))).toBe("rendered");
  });
});

describe("POST /api/account/owner-mode: the switcher", () => {
  const ORIGIN = "http://localhost";
  const post = (body: string, headers: Record<string, string> = { origin: ORIGIN }) =>
    new Request(`${ORIGIN}/api/account/owner-mode`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  const load = async () => (await import("../app/api/account/owner-mode/route")).POST as (r: Request) => Promise<Response>;

  it("refuses a customer either way, setting nothing", async () => {
    asCustomer();
    const POST = await load();
    for (const on of [true, false]) {
      const res = await POST(post(JSON.stringify({ on })));
      expect(res.status).toBe(403);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
  });

  it("refuses an admin the Owner account", async () => {
    asAdmin();
    const POST = await load();
    const res = await POST(post(JSON.stringify({ on: true })));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("does not coerce a truthy non-boolean, or a prototype trick, into on", async () => {
    asAdmin();
    const POST = await load();
    for (const body of ['{"on":"true"}', '{"on":1}', '{"on":[true]}', '{"__proto__":{"on":true}}', "true", "null", '{"on":true,"on":"x"}']) {
      const res = await POST(post(body));
      expect([400, 403], body).toContain(res.status);
      expect(res.headers.get("set-cookie") ?? "", body).not.toContain("ns_owner_mode=on");
    }
  });

  it("refuses a missing, null or foreign Origin, and a cross-site fetch carrying our Origin", async () => {
    asOwner();
    const POST = await load();
    const body = JSON.stringify({ on: true });
    expect((await POST(post(body, {}))).status).toBe(403);
    expect((await POST(post(body, { origin: "null" }))).status).toBe(403);
    expect((await POST(post(body, { origin: "http://localhost.evil.example" }))).status).toBe(403);
    expect((await POST(post(body, { origin: ORIGIN, "sec-fetch-site": "cross-site" }))).status).toBe(403);
  });

  it("a signed-out caller is 401", async () => {
    const POST = await load();
    expect((await POST(post(JSON.stringify({ on: false })))).status).toBe(401);
  });

  it("the cookie it sets is http-only, and only the owner can get on", async () => {
    asOwner();
    const POST = await load();
    const res = await POST(post(JSON.stringify({ on: true })));
    expect(res.status).toBe(200);
    expect((res.headers.get("set-cookie") ?? "").toLowerCase()).toContain("httponly");
  });
});

describe("ns_owner_mode never grants a non-operator anything", () => {
  it("viewingAsOperator is false for a customer whatever the cookie, and isPlatformOwner never reads it", async () => {
    asCustomer();
    for (const cookie of ["on", "ON", "true", "1", "", "off", "owner"]) {
      s.cookie = cookie;
      vi.resetModules();
      const view = await import("@/lib/server/owner-view");
      expect(await view.viewingAsOperator(), cookie).toBe(false);
      expect(await view.isPlatformOwner(), cookie).toBe(false);
    }
  });

  it("an admin's cookie never makes them the platform owner", async () => {
    asAdmin();
    s.cookie = "on";
    const view = await import("@/lib/server/owner-view");
    expect(await view.isPlatformOwner()).toBe(false);
  });

  it("ownerFrame needs the operator: no cookie value turns it on for anyone else", async () => {
    const { ownerFrame } = await import("@/lib/owner-mode");
    for (const c of [undefined, "on", "off", "", "ON"]) expect(ownerFrame(false, c), String(c)).toBe(false);
  });

  it("every customer page that reads the cookie or the account in view gates it on the real role", () => {
    // A page that read ns_owner_mode without the operator check would let a customer's hand-set cookie draw operator things.
    const files = [
      "app/(app)/[channel]/create/page.tsx",
      "app/(app)/[channel]/studio/page.tsx",
      "app/(app)/[channel]/models/page.tsx",
      "app/(app)/[channel]/page.tsx",
      "app/(app)/[channel]/videos/storyboard/[id]/page.tsx",
      "app/(app)/layout.tsx",
    ];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      // Reading the cookie directly is allowed only as an argument to ownerFrame(<real role>, …).
      const direct = [...src.matchAll(/get\(OWNER_MODE_COOKIE\)/g)].length;
      const framed = [...src.matchAll(/ownerFrame\((operator|isOp\w*)\s*,\s*\(await cookies\(\)\)\.get\(OWNER_MODE_COOKIE\)/g)].length;
      expect(direct, f).toBe(framed);
    }
  });
});

describe("middleware: /owner and its lookalikes are never served signed out", () => {
  const auth = { user: null as { id: string } | null };

  async function mw() {
    vi.doMock("@supabase/ssr", () => ({
      createServerClient: () => ({
        auth: {
          getUser: async () => ({ data: { user: auth.user } }),
          mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1" } }) },
        },
        rpc: async () => ({ data: false, error: null }),
      }),
    }));
    return (await import("@/middleware")) as typeof import("@/middleware");
  }

  const PATHS = [
    "/owner",
    "/owner/",
    "/owner//",
    "/OWNER",
    "/Owner/revenue",
    "/owner/revenue",
    "/owner/x/y",
    "/owner.rsc",
    "/owner/revenue.rsc",
    "/owner/../owner",
    "/owner/%2e%2e/owner",
    "/owner%2Frevenue",
    "/owner%2frevenue",
    "/%6fwner",
    "//owner",
    "/owner;/revenue",
    "/owner%00",
  ];

  it.each(PATHS)("the matcher runs for %s", async (path) => {
    const { config } = await mw();
    const { getMiddlewareMatchers } = (await import("next/dist/build/analysis/get-page-static-info")) as unknown as {
      getMiddlewareMatchers: (matcher: unknown, nextConfig: unknown) => { regexp: string }[];
    };
    const matchers = getMiddlewareMatchers(config.matcher, {}).map((m) => new RegExp(m.regexp));
    expect(matchers.some((r) => r.test(path))).toBe(true);
  });

  const KINDS: Array<[string, Record<string, string>, string]> = [
    ["a navigation", { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }, ""],
    ["an RSC fetch", { rsc: "1", "next-router-state-tree": encodeURIComponent('["",{"children":["owner",{"children":["__PAGE__",{}]}]},null,null,true]') }, "?_rsc=abc"],
    ["a prefetch", { rsc: "1", "next-router-prefetch": "1", purpose: "prefetch" }, "?_rsc=1"],
  ];

  for (const [kind, headers, search] of KINDS) {
    it.each(PATHS)(`signed out, ${kind} of %s is sent to /login or the 404`, async (path) => {
      auth.user = null;
      const { middleware } = await mw();
      const res = await middleware(new NextRequest(`https://nightshift.test${path}${search}`, { headers }));
      if (res.status === 404) {
        expect(new URL(res.headers.get("x-middleware-rewrite") ?? "https://x/").pathname).toBe("/_not-found");
        return;
      }
      expect(res.status, path).toBe(307);
      expect(new URL(res.headers.get("location") ?? "https://x/").pathname).toMatch(/^\/login\/?$/);
    });
  }

  it("signed in, /owner is not rewritten into a channel URL (the layout is what decides, and it 404s a customer)", async () => {
    auth.user = { id: "cust-1" };
    const { middleware } = await mw();
    const res = await middleware(new NextRequest("https://nightshift.test/owner", { headers: { "sec-fetch-mode": "navigate" } }));
    expect(res.headers.get("location")).toBeNull();
  });
});
