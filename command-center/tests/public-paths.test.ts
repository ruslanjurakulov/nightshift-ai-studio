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
  it.each(["/privacy/videos", "/terms/command-center", "/privacy-policy", "/termsx", "/pricing/credits", "/pricing-old"])(
    "do not get %s just because it starts like a public page",
    async (path) => {
      expect((await visit(path, false)).redirect).toBe("/login");
    },
  );
});

describe("signed-in users keep today's behaviour", () => {
  it("are sent from / to the Command Center of the channel they last viewed", async () => {
    auth.user = { id: "u1" };
    const req = new NextRequest("https://nightshift.test/");
    req.cookies.set("chronos_channel", "chronos");
    const res = await middleware(req);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/chronos/command-center");
  });

  it("are sent from / to every channel when no channel is remembered", async () => {
    expect((await visit("/", true)).redirect).toBe("/all-channels/command-center");
  });

  it("are sent away from /login", async () => {
    expect((await visit("/login", true)).redirect).toBe("/");
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

  it("never lets a signed-out visitor into an app route", () => {
    for (const path of ["/x", "/all-channels", "/api/agent/run", "/chronos/privacy", "/chronos/pricing"]) {
      expect(gateDecision(path, false)).toBe("to-login");
    }
  });
});

describe("channel ids", () => {
  it.each(["privacy", "terms", "pricing", "login", "api"])(
    "cannot be %s, which would be shadowed by a page at the root",
    (id) => {
      expect(isValidChannelId(id)).toBe(false);
    },
  );
});
