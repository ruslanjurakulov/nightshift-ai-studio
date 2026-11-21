/**
 * A signed-in visitor on /signup or /login with a Studio form to come back to (the landing's idea box, a sample's "Try this prompt")
 * goes straight to it. The static landing cannot know who is signed in, so it always links through sign-up; without this the visitor
 * landed on "/" and the idea was never seen. Only the Studio shape passes: anything else still goes home (no open redirect).
 */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { IDEA_NEXT } from "@/lib/site/idea-handoff";

const auth = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: auth.user } }) } }),
}));
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://project.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));

const { middleware } = await import("@/middleware");

describe("signed in on sign-up or sign-in with a Studio form to come back to", () => {
  const nav = { headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } };

  it.each(["/signup", "/login"])("%s sends a signed-in visitor straight to the Studio form, not to /", async (page) => {
    auth.user = { id: "u1" };
    const res = await middleware(new NextRequest(`https://nightshift.test${page}?next=${encodeURIComponent(IDEA_NEXT)}`, nav));
    const to = new URL(res.headers.get("location") ?? "https://x/");
    expect(to.origin).toBe("https://nightshift.test");
    expect(`${to.pathname}${to.search}`).toBe(IDEA_NEXT);
  });

  it.each([
    "https://evil.example/all-channels/create",
    "//evil.example/all-channels/create",
    "/\\evil.example",
    "/settings",
    "/all-channels/createx",
    "/api/account",
  ])("any other next (%s) still goes home: no open redirect", async (next) => {
    auth.user = { id: "u1" };
    const res = await middleware(new NextRequest(`https://nightshift.test/signup?next=${encodeURIComponent(next)}`, nav));
    const to = new URL(res.headers.get("location") ?? "https://x/");
    expect(to.origin).toBe("https://nightshift.test");
    expect(to.pathname).toBe("/");
  });

  it("signed out, sign-up is served (the visitor signs up with the next intact)", async () => {
    auth.user = null;
    const res = await middleware(new NextRequest(`https://nightshift.test/signup?next=${encodeURIComponent(IDEA_NEXT)}`, nav));
    expect(res.headers.get("location")).toBeNull();
  });
});
