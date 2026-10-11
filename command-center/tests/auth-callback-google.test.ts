import { beforeEach, describe, expect, it, vi } from "vitest";

// The Google half of /auth/callback: the code exchange returns a user, and the
// verified-email gate decides whether the session is kept.
const h = vi.hoisted(() => ({
  exchange: vi.fn(),
  signOut: vi.fn(async (_o?: unknown) => ({ error: null })),
  join: vi.fn(async () => undefined),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession: h.exchange, signOut: h.signOut } }),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: {} }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => undefined }) }));
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
  h.signOut.mockClear();
  h.join.mockClear();
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
});
