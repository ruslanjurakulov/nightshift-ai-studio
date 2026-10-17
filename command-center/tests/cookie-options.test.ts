// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServerClient } from "@supabase/ssr";
import {
  SESSION_COOKIE_MAX_AGE_SECONDS,
  browserCookieStorage,
  hardenSessionCookie,
} from "../lib/supabase/cookie-options";

/**
 * The session cookie (ledger BR-S-021). @supabase/ssr 0.5.x writes it with maxAge 400 days, no Secure, and IGNORES a
 * maxAge passed through `cookieOptions`, so the options are hardened where the cookie is written (the `setAll` of each
 * client). What would break without these: a session cookie that travels over plain http, or that outlives an abandoned
 * browser by more than a year, or a "hardening" that stops the session from refreshing.
 */

afterEach(() => vi.unstubAllEnvs());

describe("hardenSessionCookie", () => {
  it("production: Secure, SameSite=Lax, 30 days at most, path /", () => {
    expect(hardenSessionCookie({ path: "/", sameSite: "lax", httpOnly: false, maxAge: 400 * 24 * 60 * 60 }, true)).toEqual({
      path: "/",
      sameSite: "lax",
      httpOnly: false,
      maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
      secure: true,
    });
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(2_592_000);
  });

  it("development and tests: no Secure (plain http://localhost keeps working), still capped and Lax", () => {
    const o = hardenSessionCookie({ maxAge: 999_999_999 }, false);
    expect(o.secure).toBeUndefined();
    expect(o.maxAge).toBe(SESSION_COOKIE_MAX_AGE_SECONDS);
    expect(o.sameSite).toBe("lax");
  });

  it("a shorter lifetime is kept; a deletion (0 or negative) stays a deletion", () => {
    expect(hardenSessionCookie({ maxAge: 3600 }, true).maxAge).toBe(3600);
    expect(hardenSessionCookie({ maxAge: 0 }, true).maxAge).toBe(0);
    expect(hardenSessionCookie({ maxAge: -1 }, true).maxAge).toBe(-1);
    expect(hardenSessionCookie(undefined, true).maxAge).toBe(SESSION_COOKIE_MAX_AGE_SECONDS);
  });

  it("never SameSite=None (or a boolean or junk); Strict is kept if asked", () => {
    expect(hardenSessionCookie({ sameSite: "none" }, true).sameSite).toBe("lax");
    expect(hardenSessionCookie({ sameSite: undefined }, true).sameSite).toBe("lax");
    expect(hardenSessionCookie({ sameSite: "strict" }, true).sameSite).toBe("strict");
  });

  it("httpOnly is NOT turned on: the browser client reads the session from document.cookie", () => {
    expect(hardenSessionCookie({ httpOnly: false }, true).httpOnly).toBe(false);
    expect(hardenSessionCookie({}, true).httpOnly).toBeUndefined();
  });

  it("follows NODE_ENV by default", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(hardenSessionCookie({}).secure).toBe(true);
    vi.stubEnv("NODE_ENV", "test");
    expect(hardenSessionCookie({}).secure).toBeUndefined();
  });
});

describe("a real @supabase/ssr server client refresh, hardened in setAll", () => {
  function jwt(claims: Record<string, unknown>) {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;
  }
  const now = Math.floor(Date.now() / 1000);
  const session = (exp: number, refresh: string) => ({
    access_token: jwt({ sub: "u1", exp, aal: "aal1", amr: [{ method: "password", timestamp: now }], role: "authenticated" }),
    refresh_token: refresh,
    expires_in: exp - now,
    expires_at: exp,
    token_type: "bearer",
    user: { id: "u1", aud: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" },
  });

  it("an expired access token is refreshed and the cookies written carry Secure, Lax and 30 days", async () => {
    const stale = session(now - 100, "old-refresh");
    const fresh = session(now + 3600, "new-refresh");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/v1/token")) return Response.json(fresh);
      if (url.includes("/auth/v1/user")) return Response.json(fresh.user);
      return Response.json({});
    });
    const written: { name: string; value: string; options: Record<string, unknown> }[] = [];
    const supabase = createServerClient("https://project.supabase.test", "anon", {
      global: { fetch: fetchMock as unknown as typeof fetch },
      cookies: {
        getAll: () => [{ name: "sb-project-auth-token", value: JSON.stringify(stale) }],
        setAll: (cookies) => {
          for (const c of cookies) written.push({ ...c, options: hardenSessionCookie(c.options, true) } as never);
        },
      },
      cookieEncoding: "raw" as never,
    });
    const { data } = await supabase.auth.getUser();
    // The refresh went through: the user is signed in, a new session was stored, and every cookie is hardened.
    expect(data.user?.id).toBe("u1");
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("grant_type=refresh_token"))).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(written.length).toBeGreaterThan(0);
    for (const c of written) {
      expect(c.options.secure, c.name).toBe(true);
      expect(c.options.sameSite, c.name).toBe("lax");
      expect(Number(c.options.maxAge), c.name).toBeLessThanOrEqual(SESSION_COOKIE_MAX_AGE_SECONDS);
      expect(c.options.path, c.name).toBe("/");
    }
    expect(written.some((c) => c.value && c.value.includes("new-refresh"))).toBe(true);
  });

  it("the library really ignores cookieOptions.maxAge (so hardening in setAll is what shortens it)", async () => {
    const fresh = session(now + 3600, "r2");
    const out: { options: { maxAge?: number } }[] = [];
    const supabase = createServerClient("https://project.supabase.test", "anon", {
      cookieOptions: { maxAge: 60 },
      global: { fetch: (async () => Response.json({ ...fresh, user: fresh.user })) as unknown as typeof fetch },
      cookies: { getAll: () => [], setAll: (c) => void out.push(...(c as never[])) },
      cookieEncoding: "raw" as never,
    });
    await supabase.auth.setSession({ access_token: fresh.access_token, refresh_token: "r2" });
    await new Promise((r) => setTimeout(r, 0));
    expect(out.length).toBeGreaterThan(0);
    // 400 days: the library's own constant wins over the option we passed.
    expect(out[0].options.maxAge).toBe(400 * 24 * 60 * 60);
  });
});

describe("browserCookieStorage (the browser client's document.cookie)", () => {
  it("writes the cookie with SameSite=Lax and a 30-day max-age, and reads it back", () => {
    const store = browserCookieStorage(false);
    store.setAll([{ name: "sb-x-auth-token", value: "v1", options: { path: "/", maxAge: 400 * 24 * 60 * 60, sameSite: "lax" } }]);
    expect(store.getAll()).toEqual([{ name: "sb-x-auth-token", value: "v1" }]);
    // a deletion (maxAge 0) removes it
    store.setAll([{ name: "sb-x-auth-token", value: "", options: { path: "/", maxAge: 0 } }]);
    expect(store.getAll()).toEqual([]);
  });

  it("serialises Secure in production and the capped Max-Age", () => {
    const setter = vi.spyOn(document, "cookie", "set");
    browserCookieStorage(true).setAll([{ name: "sb-y", value: "v", options: { maxAge: 400 * 24 * 60 * 60 } }]);
    const header = String(setter.mock.calls.at(-1)?.[0]);
    expect(header).toContain("Max-Age=2592000");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Lax");
    expect(header).not.toContain("HttpOnly");
    setter.mockRestore();
  });
});

describe("all three places that write the session cookie harden it", () => {
  const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");
  it("server client and middleware call hardenSessionCookie in setAll; the browser client uses browserCookieStorage", () => {
    expect(read("lib/supabase/server.ts")).toContain("hardenSessionCookie(options)");
    expect(read("middleware.ts")).toContain("hardenSessionCookie(options)");
    expect(read("lib/supabase/client.ts")).toContain("browserCookieStorage()");
  });
});
