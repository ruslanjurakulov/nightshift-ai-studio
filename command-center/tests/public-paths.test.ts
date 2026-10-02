import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { gateDecision, isPublicPath } from "@/lib/public-paths";
import { isValidChannelId } from "@/lib/channels";

// The middleware only asks Supabase one question — who is signed in — so the
// client is replaced by one whose answer each test sets.
const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: auth.user } }) },
  }),
}));

vi.mock("@/lib/config", () => ({
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon",
  isSupabaseConfigured: true,
}));

const { middleware } = await import("@/middleware");

async function visit(path: string, signedIn: boolean) {
  auth.user = signedIn ? { id: "u1" } : null;
  const res = await middleware(new NextRequest(`https://nightshift.test${path}`));
  const location = res.headers.get("location");
  return { redirect: location ? new URL(location).pathname : null, res };
}

beforeEach(() => {
  auth.user = null;
});

describe("signed-out visitors (what Google's reviewer sees)", () => {
  it.each(["/", "/privacy", "/terms", "/pricing"])("can open %s without being sent to /login", async (path) => {
    expect((await visit(path, false)).redirect).toBeNull();
  });

  it("can still reach the sign-in page", async () => {
    expect((await visit("/login", false)).redirect).toBeNull();
  });

  it.each(["/signup", "/signup/", "/auth/callback", "/auth/callback?code=abc&next=/welcome"])(
    "can open the sign-up flow at %s",
    async (path) => {
      expect((await visit(path, false)).redirect).toBeNull();
    },
  );

  // Exact matching, as for the legal pages: /signup/x would be the "x" screen
  // of a channel called "signup", and /auth/anything else is not the callback.
  it.each(["/signup/x", "/signup/videos", "/auth", "/auth/callback/x", "/auth/other", "/welcome"])(
    "are sent to /login from %s",
    async (path) => {
      expect((await visit(path, false)).redirect).toBe("/login");
    },
  );

  it.each([
    "/all-channels/command-center",
    "/chronos/videos",
    "/videos",
    "/api/setup/secrets",
    "/api/oauth/youtube/start",
    "/api/oauth/youtube/callback",
  ])("are still redirected to /login from the app URL %s", async (path) => {
    expect((await visit(path, false)).redirect).toBe("/login");
  });

  // Prefix matching would have published a channel's screens: the router reads
  // /privacy/videos as the Videos page of a channel whose segment is "privacy".
  it.each(["/privacy/videos", "/terms/command-center", "/pricing/credits"])(
    "do not get %s just because it starts like a public page",
    async (path) => {
      expect((await visit(path, false)).redirect).toBe("/login");
    },
  );

  // …and a one-segment look-alike is not a page at all: it gets the 404.
  it.each(["/signupx", "/privacy-policy", "/termsx", "/pricing-old"])(
    "do not get %s just because it starts like a public page (404)",
    async (path) => {
      const { redirect, res } = await visit(path, false);
      expect(redirect).toBeNull();
      expect(res.status).toBe(404);
      expect(new URL(res.headers.get("x-middleware-rewrite") ?? "").pathname).toBe("/_not-found");
    },
  );
});

describe("signed-out visitors on a URL that is not a page", () => {
  // A mistyped or invented URL is the 404 — never the app's frame, never a
  // sign-in form for something that was never there.
  it.each(["/blog", "/about", "/contact", "/no-such-page-xyz", "/blog/", "/chronos", "/x"])(
    "get the 404 for %s, served by the not-found page alone",
    async (path) => {
      const { redirect, res } = await visit(path, false);
      expect(redirect).toBeNull();
      expect(res.status).toBe(404);
      expect(new URL(res.headers.get("x-middleware-rewrite") ?? "").pathname).toBe("/_not-found");
      // Nothing about a channel is handed inward: no app layout resolves it.
      expect(res.headers.get("x-middleware-request-x-nightshift-channel")).toBeNull();
    },
  );

  // Uniform on purpose: a real channel's segment and an invented one get the
  // same answer, so the 404 says nothing about which channels exist.
  it("answer a real channel's bare segment exactly like an invented one", async () => {
    const real = await visit("/chronos", false);
    const invented = await visit("/zz-not-a-channel", false);
    expect(real.res.status).toBe(invented.res.status);
    expect(real.res.headers.get("x-middleware-rewrite")).toBe(invented.res.headers.get("x-middleware-rewrite"));
  });

  it.each(["/xyz/videos", "/chronos/videos", "/all-channels", "/videos", "/welcome", "/auth", "/docs", "/api", "/api/agent/run"])(
    "are still sent to /login from the app-shaped or reserved URL %s",
    async (path) => {
      expect((await visit(path, false)).redirect).toBe("/login");
    },
  );

  it("does not change what a signed-in user gets for an unknown segment", async () => {
    const { redirect, res } = await visit("/blog", true);
    expect(res.status).not.toBe(404);
    expect(redirect).toBeNull();
    expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  });
});

describe("signed-in users keep today's behaviour", () => {
  // The channel's index page then picks where this viewer starts (operator:
  // Command Center; customer: Studio) — middleware cannot tell them apart.
  it("are sent from / to the channel they last viewed", async () => {
    auth.user = { id: "u1" };
    const req = new NextRequest("https://nightshift.test/");
    req.cookies.set("chronos_channel", "chronos");
    const res = await middleware(req);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/chronos");
  });

  // The bare segment's index page then opens the first channel — nobody starts
  // on the every-channel roll-up (app/(app)/[channel]/page.tsx).
  it("are sent from / to the landing segment when no channel is remembered", async () => {
    expect((await visit("/", true)).redirect).toBe("/all-channels");
  });

  it("treat a remembered every-channel view like no memory at all", async () => {
    auth.user = { id: "u1" };
    const req = new NextRequest("https://nightshift.test/");
    req.cookies.set("chronos_channel", "all-channels");
    const res = await middleware(req);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/all-channels");
  });

  it("send an old channelless link to the same screen, keeping its query", async () => {
    auth.user = { id: "u1" };
    const req = new NextRequest("https://nightshift.test/channels?yt=connected");
    req.cookies.set("chronos_channel", "chronos");
    const url = new URL((await middleware(req)).headers.get("location")!);
    expect(url.pathname + url.search).toBe("/chronos/channels?yt=connected");
  });

  it("hand the query string inward, so a layout redirect can keep it", async () => {
    auth.user = { id: "u1" };
    const res = await middleware(new NextRequest("https://nightshift.test/chronos/channels?yt=connected"));
    expect(res.headers.get("x-middleware-request-x-nightshift-search")).toBe("?yt=connected");
  });

  it("route bare /create and /credits onto a channel", async () => {
    for (const section of ["create", "credits", "billing"]) {
      auth.user = { id: "u1" };
      const req = new NextRequest(`https://nightshift.test/${section}`);
      req.cookies.set("chronos_channel", "chronos");
      const res = await middleware(req);
      expect(new URL(res.headers.get("location")!).pathname, section).toBe(`/chronos/${section}`);
    }
  });

  it("are sent away from /login", async () => {
    expect((await visit("/login", true)).redirect).toBe("/");
  });

  it("are sent away from /signup to their app", async () => {
    expect((await visit("/signup", true)).redirect).toBe("/");
  });

  // A confirmation link opened in a browser that still holds another session
  // must reach the callback, which replaces it.
  it("still reach the auth callback", async () => {
    const { redirect, res } = await visit("/auth/callback?code=abc", true);
    expect(redirect).toBeNull();
    expect(res.headers.get("x-middleware-request-x-nightshift-channel")).toBeNull();
  });

  // /welcome is its own page, not a channel called "welcome".
  it("open /welcome as it is, without a channel header", async () => {
    const { redirect, res } = await visit("/welcome", true);
    expect(redirect).toBeNull();
    expect(res.headers.get("x-middleware-request-x-nightshift-channel")).toBeNull();
  });

  it("still get old section links rewritten onto a channel", async () => {
    expect((await visit("/videos", true)).redirect).toBe("/all-channels/videos");
  });

  it("reach app screens with the channel handed inward", async () => {
    const { redirect, res } = await visit("/chronos/videos", true);
    expect(redirect).toBeNull();
    expect(res.headers.get("x-middleware-request-x-nightshift-channel")).toBe("chronos");
  });

  it("can read the legal pages too", async () => {
    expect((await visit("/privacy", true)).redirect).toBeNull();
    expect((await visit("/terms", true)).redirect).toBeNull();
  });

  // Pricing is a page of its own for everyone: a signed-in user must not be
  // rewritten onto a channel called "pricing" or handed a channel header.
  it("can read the pricing page as it is", async () => {
    const { redirect, res } = await visit("/pricing", true);
    expect(redirect).toBeNull();
    expect(res.headers.get("x-middleware-request-x-nightshift-channel")).toBeNull();
  });
});

describe("gateDecision", () => {
  it("treats a trailing slash like the router does", () => {
    expect(isPublicPath("/terms/")).toBe(true);
    expect(gateDecision("/privacy/", false)).toBe("pass");
    expect(gateDecision("/pricing/", true)).toBe("pass");
  });

  it("puts the sign-up flow on the public surface, exactly", () => {
    expect(isPublicPath("/signup")).toBe(true);
    expect(isPublicPath("/auth/callback")).toBe(true);
    expect(isPublicPath("/signup/x")).toBe(false);
    expect(isPublicPath("/auth/callback/x")).toBe(false);
    expect(isPublicPath("/welcome")).toBe(false);
    expect(gateDecision("/signup", false)).toBe("pass");
    expect(gateDecision("/signup", true)).toBe("to-home");
    expect(gateDecision("/auth/callback", false)).toBe("pass");
    expect(gateDecision("/auth/callback", true)).toBe("pass");
    expect(gateDecision("/welcome", false)).toBe("to-login");
    expect(gateDecision("/welcome", true)).toBe("pass");
    expect(gateDecision("/signup/x", false)).toBe("to-login");
    expect(gateDecision("/signup/x", true)).toBe("app");
  });

  it("never lets a signed-out visitor into an app route", () => {
    for (const path of ["/x", "/all-channels", "/api/agent/run", "/chronos/privacy", "/chronos/pricing"]) {
      expect(gateDecision(path, false)).toBe("to-login");
    }
  });
});

describe("channel ids", () => {
  it.each(["privacy", "terms", "pricing", "login", "api", "signup", "auth", "welcome"])(
    "cannot be %s, which would be shadowed by a page at the root",
    (id) => {
      expect(isValidChannelId(id)).toBe(false);
    },
  );
});
