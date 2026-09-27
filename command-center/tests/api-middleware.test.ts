import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { gateDecision, isPublicApiPath } from "@/lib/public-paths";
import { isValidChannelId } from "@/lib/channels";

const auth = vi.hoisted(() => ({ user: null as { id: string } | null, calls: 0 }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => {
        auth.calls += 1;
        return { data: { user: auth.user } };
      },
    },
  }),
}));

vi.mock("@/lib/config", () => ({
  SUPABASE_URL: "https://project.supabase.test",
  SUPABASE_ANON_KEY: "anon",
  isSupabaseConfigured: true,
}));

const { middleware } = await import("@/middleware");

beforeEach(() => {
  auth.user = null;
  auth.calls = 0;
});

describe("the public API and its docs pass the cookie gate", () => {
  it.each(["/api/v1", "/api/v1/videos", "/api/v1/videos/abc/publish", "/api/v1/jobs/1"])(
    "%s is served signed out, without a session lookup",
    async (path) => {
      const res = await middleware(new NextRequest(`https://nightshift.test${path}`));
      expect(res.headers.get("location")).toBeNull();
      expect(auth.calls).toBe(0);
    },
  );

  it.each(["/api/v10", "/api/v1x", "/api/v1videos", "/api/account", "/api/agent/run"])(
    "%s is not the public API and stays behind sign-in",
    async (path) => {
      expect(isPublicApiPath(path)).toBe(false);
      const res = await middleware(new NextRequest(`https://nightshift.test${path}`));
      expect(new URL(res.headers.get("location") ?? "https://x/").pathname).toBe("/login");
    },
  );

  it("serves the API reference and its OpenAPI spec signed out", () => {
    expect(gateDecision("/docs/api", false)).toBe("pass");
    expect(gateDecision("/docs/api/openapi.json", false)).toBe("pass");
    expect(gateDecision("/docs/other", false)).toBe("to-login");
  });

  it("reserves 'docs' and 'developers' so no channel can take them", () => {
    expect(isValidChannelId("docs")).toBe(false);
    expect(isValidChannelId("developers")).toBe(false);
  });
});
