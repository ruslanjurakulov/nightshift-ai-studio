import { beforeEach, describe, expect, it, vi } from "vitest";

// The Google half of /auth/callback: the code exchange returns a user, and the
// verified-email gate decides whether the session is kept.
const h = vi.hoisted(() => ({
  exchange: vi.fn(),
  signOut: vi.fn(async (_o?: unknown): Promise<{ error: unknown }> => ({ error: null })),
  join: vi.fn(async () => undefined),
  jar: new Map<string, string>(),
  expired: [] as string[],
  written: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession: h.exchange, signOut: h.signOut } }),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: {} }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    getAll: () => [...h.jar].map(([name, value]) => ({ name, value })),
    set: (name: string, _value: string, opts?: { maxAge?: number }) => {
      if (opts?.maxAge !== 0) h.written.push(name);
      if (opts?.maxAge === 0) {
        h.jar.delete(name);
        h.expired.push(name);
      }
    },
  }),
}));
vi.mock("@/lib/server/friend-invites", () => ({ joinFromCookie: h.join }));

const { GET } = await import("@/app/auth/callback/route");

async function land(query: string) {
  const res = await GET(new Request(`https://nightshift.test/auth/callback${query}`));
  const loc = new URL(res.headers.get("location")!);
  return loc.pathname + loc.search;
}
const session = (verified: unknown, confirmed: string | null = "2026-10-11T10:00:00Z") => ({
  data: {
    user: { email_confirmed_at: confirmed, identities: [{ provider: "google", identity_data: { email_verified: verified } }] },
  },
  error: null,
});

beforeEach(() => {
  h.exchange.mockReset();
  h.signOut.mockReset();
  h.signOut.mockResolvedValue({ error: null });
  h.join.mockClear();
  h.jar.clear();
  h.expired.length = 0;
  h.written.length = 0;
  // What the code exchange just wrote (chunked, as @supabase/ssr does), a PKCE leftover and an unrelated cookie.
  h.jar.set("sb-proj-auth-token.0", "a");
  h.jar.set("sb-proj-auth-token.1", "b");
  h.jar.set("sb-proj-auth-token-code-verifier", "v");
  h.jar.set("ns_locale", "en");
});

describe("/auth/callback after Continue with Google", () => {
  it("a verified Google user is signed in, the invite cookie is honoured, and next is followed", async () => {
    h.exchange.mockResolvedValue(session(true));
    expect(await land("?code=c1&provider=google&next=%2Fwelcome")).toBe("/welcome");
    expect(h.join).toHaveBeenCalledTimes(1);
    expect(h.signOut).not.toHaveBeenCalled();
  });

  it("an unverified Google email: the session is dropped and nobody joins", async () => {
    h.exchange.mockResolvedValue(session(false));
    expect(await land("?code=c1&provider=google&next=%2Fwelcome")).toBe("/login?error=google_unverified");
    expect(h.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(h.join).not.toHaveBeenCalled();
  });

  it("an unconfirmed user is refused even if the claim says verified", async () => {
    h.exchange.mockResolvedValue(session(true, null));
    expect(await land("?code=c1&provider=google")).toBe("/login?error=google_unverified");
    expect(h.signOut).toHaveBeenCalled();
  });

  it("dropping the marker does not skip the gate for an account with a Google identity", async () => {
    h.exchange.mockResolvedValue(session(false));
    expect(await land("?code=c1")).toBe("/login?error=google_unverified");
  });

  it("a failed exchange on a Google attempt is a fixed Google error", async () => {
    h.exchange.mockResolvedValue({ data: { user: null }, error: { code: "flow_state_not_found", message: "secret detail" } });
    expect(await land("?code=c1&provider=google")).toBe("/login?error=google_failed");
  });

  it("Cancel on Google's screen comes back as google_denied, without the provider's text", async () => {
    const p = await land("?provider=google&error=access_denied&error_description=Some+provider+words");
    expect(p).toBe("/login?error=google_denied");
    expect(h.exchange).not.toHaveBeenCalled();
  });

  it("an expired email link keeps its own message", async () => {
    expect(await land("?error=access_denied&error_code=otp_expired")).toBe("/login?error=link_expired");
  });

  it("an off-site next falls back to /welcome after Google", async () => {
    h.exchange.mockResolvedValue(session(true));
    expect(await land("?code=c1&provider=google&next=https%3A%2F%2Fevil.example")).toBe("/welcome");
  });

  describe("with password recovery (#418): the gate comes first", () => {
    it("a refused Google session is never turned into a recovery session, whatever the exchange says", async () => {
      const bad = session(false);
      (bad.data as Record<string, unknown>).redirectType = "PASSWORD_RECOVERY";
      h.exchange.mockResolvedValue(bad);
      expect(await land("?code=c1&provider=google&next=%2Freset-password")).toBe("/login?error=google_unverified");
      expect(h.written).toEqual([]);
      expect(h.signOut).toHaveBeenCalled();
    });

    it("a Google attempt that fails with next=/reset-password goes to /login, not to the reset-link page", async () => {
      expect(await land("?provider=google&error=access_denied&next=%2Freset-password")).toBe("/login?error=google_denied");
      h.exchange.mockResolvedValue({ data: { user: null }, error: { code: "x" } });
      expect(await land("?code=c1&provider=google&next=%2Freset-password")).toBe("/login?error=google_failed");
    });

    it("an ordinary recovery link is untouched: marker cookie set, sent to /reset-password", async () => {
      h.exchange.mockResolvedValue({
        data: { redirectType: "PASSWORD_RECOVERY", user: { id: "u1", email_confirmed_at: "2026-10-11T10:00:00Z", identities: [{ provider: "email" }] } },
        error: null,
      });
      expect(await land("?code=c1&next=%2Freset-password")).toBe("/reset-password");
      expect(h.written).toHaveLength(1);
      expect(h.join).not.toHaveBeenCalled();
    });

    it("a failed ordinary reset link still goes to /forgot-password", async () => {
      h.exchange.mockResolvedValue({ data: { user: null }, error: { code: "flow_state_not_found" } });
      expect(await land("?code=c1&next=%2Freset-password")).toMatch(/^\/forgot-password\?s=/);
    });
  });

  describe("a denied session is always dropped from this browser", () => {
    const cleared = () => {
      expect(h.expired.sort()).toEqual(["sb-proj-auth-token-code-verifier", "sb-proj-auth-token.0", "sb-proj-auth-token.1"]);
      expect(h.jar.has("ns_locale")).toBe(true);
    };

    it("when logout answers with an error (5xx)", async () => {
      h.exchange.mockResolvedValue(session(false));
      h.signOut.mockResolvedValue({ error: { status: 503, message: "upstream" } });
      expect(await land("?code=c1&provider=google")).toBe("/login?error=google_unverified");
      expect(h.signOut).toHaveBeenCalledWith({ scope: "local" });
      cleared();
    });

    it("when logout throws (network down)", async () => {
      h.exchange.mockResolvedValue(session(false));
      h.signOut.mockRejectedValue(new Error("fetch failed"));
      expect(await land("?code=c1&provider=google")).toBe("/login?error=google_unverified");
      cleared();
    });

    it("when logout works", async () => {
      h.exchange.mockResolvedValue(session(false));
      expect(await land("?code=c1&provider=google")).toBe("/login?error=google_unverified");
      cleared();
    });
  });

  describe("the verified-email claim is strict", () => {
    const withIdentity = (identity_data: unknown) => ({
      data: {
        user: { email_confirmed_at: "2026-10-11T10:00:00Z", identities: [{ provider: "google", identity_data }] },
      },
      error: null,
    });

    it.each([
      ['the string "true"', withIdentity({ email_verified: "true" })],
      ["a missing claim", withIdentity({})],
      ["no identity_data", withIdentity(undefined)],
    ])("%s is refused", async (_n, result) => {
      h.exchange.mockResolvedValue(result);
      expect(await land("?code=c1&provider=google")).toBe("/login?error=google_unverified");
      expect(h.signOut).toHaveBeenCalled();
      expect(h.join).not.toHaveBeenCalled();
    });

    it("no identities at all and no user_metadata claim is refused", async () => {
      h.exchange.mockResolvedValue({ data: { user: { email_confirmed_at: "2026-10-11T10:00:00Z" } }, error: null });
      expect(await land("?code=c1&provider=google")).toBe("/login?error=google_unverified");
      expect(h.signOut).toHaveBeenCalled();
    });

    it("an identities list without Google, on a Google attempt, is a failure", async () => {
      h.exchange.mockResolvedValue({
        data: { user: { email_confirmed_at: "x", identities: [{ provider: "email", identity_data: { email_verified: true } }] } },
        error: null,
      });
      expect(await land("?code=c1&provider=google")).toBe("/login?error=google_failed");
    });
  });

  it("an email-only user's confirmation link passes through the gate untouched", async () => {
    h.exchange.mockResolvedValue({
      data: { user: { email_confirmed_at: "2026-10-11T10:00:00Z", identities: [{ provider: "email", identity_data: { email_verified: true } }] } },
      error: null,
    });
    expect(await land("?code=c1&next=%2Fwelcome")).toBe("/welcome");
    expect(h.signOut).not.toHaveBeenCalled();
    expect(h.expired).toEqual([]);
    expect(h.jar.size).toBe(4);
    expect(h.join).toHaveBeenCalledTimes(1);
  });
});
