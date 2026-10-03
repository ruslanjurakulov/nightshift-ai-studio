import type { Rpc } from "@/lib/api/operations";

/**
 * An in-memory stand-in for the oauth_* functions of migration 0093, enough to
 * play a whole client through the route handlers. It restates the rules the
 * database enforces (single-use codes with reuse revocation, PKCE digest,
 * rotating refresh tokens with reuse detection, expiry, entitlement, a
 * spending limit counted in credits, credits and not US cents) so the HANDLERS'
 * behaviour — hashing, headers, error mapping, audience, scopes — is tested
 * without a database. The real functions are attacked in tests/security
 * (test_sec_mcp_oauth.py) and, with the official SDK, by tests/oauth_e2e.
 */

interface Grant {
  id: string;
  clientId: string;
  scopes: string[];
  resource: string;
  limit: number;
  revoked: boolean;
  activated: boolean;
}

export class FakeOauthDb {
  clients = new Map<string, { name: string; uris: string[] }>();
  codes = new Map<string, { grant: string; clientId: string; redirect: string; challenge: string; resource: string; used: boolean; expires: number }>();
  tokens = new Map<string, { grant: string; kind: "access" | "refresh"; expires: number; used: boolean; revoked: boolean }>();
  grants = new Map<string, Grant>();
  requests = new Map<string, { clientId: string; redirect: string; challenge: string; state: string | null; scopes: string[]; resource: string }>();
  now = 1_000_000;
  entitled = true;
  credits = { available: 400, held: 0 };
  spent = 0;
  runLimit = 2;
  active = 0;
  calls: { fn: string; args: Record<string, unknown> }[] = [];
  usdTouched = false;
  private seq = 0;

  rpc: Rpc = async (fn, args) => {
    this.calls.push({ fn, args });
    const out = (this as unknown as Record<string, (a: Record<string, unknown>) => unknown>)[fn]?.call(this, args);
    if (out === undefined) return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    return { data: out, error: null };
  };

  oauth_register_client(a: Record<string, unknown>) {
    const id = `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`;
    this.clients.set(id, { name: a.p_name as string, uris: a.p_redirect_uris as string[] });
    return { ok: true, client_id: id };
  }

  /** The signed-in person's half (called through the session client in production). */
  begin(a: { clientId: string; redirectUri: string; secretHash: string; codeChallenge: string; state: string | null; scope: string | null; resource: string }) {
    const c = this.clients.get(a.clientId);
    if (!c) return { ok: false, error: "unknown_client" };
    if (!c.uris.includes(a.redirectUri)) return { ok: false, error: "redirect_mismatch" };
    if (!this.entitled) return { ok: true, entitled: false, client_name: c.name, workspace_name: "Alice Studio", plan: "free" };
    this.requests.set(a.secretHash, {
      clientId: a.clientId, redirect: a.redirectUri, challenge: a.codeChallenge, state: a.state,
      scopes: ["videos:read", "videos:create", "videos:publish"], resource: a.resource,
    });
    return { ok: true, entitled: true, client_name: c.name, redirect_uri: a.redirectUri, workspace_name: "Alice Studio", plan: "creator",
      scopes: ["videos:read", "videos:create", "videos:publish"], default_limit_credits: 500, max_limit_credits: 20000, exempt: false };
  }

  decide(a: { secretHash: string; allow: boolean; limit: number | null; codeHash: string }) {
    const r = this.requests.get(a.secretHash);
    this.requests.delete(a.secretHash);
    if (!r) return { ok: false, error: "expired" };
    if (!a.allow) return { ok: true, allowed: false, redirect_uri: r.redirect, state: r.state };
    const id = `g${++this.seq}`;
    this.grants.set(id, { id, clientId: r.clientId, scopes: r.scopes, resource: r.resource, limit: a.limit ?? 0, revoked: false, activated: false });
    this.codes.set(a.codeHash, { grant: id, clientId: r.clientId, redirect: r.redirect, challenge: r.challenge, resource: r.resource, used: false, expires: this.now + 60 });
    return { ok: true, allowed: true, redirect_uri: r.redirect, state: r.state };
  }

  private revoke(grant: string) {
    const g = this.grants.get(grant);
    if (g) g.revoked = true;
    for (const t of this.tokens.values()) if (t.grant === grant) t.revoked = true;
  }

  oauth_exchange_code(a: Record<string, string>) {
    const bad = { ok: false, error: "invalid_grant" };
    const c = this.codes.get(a.p_code_hash);
    if (!c) return bad;
    if (c.used) { this.revoke(c.grant); return bad; }
    if (c.expires < this.now || this.grants.get(c.grant)?.revoked) return bad;
    if (c.clientId !== a.p_client_id || c.redirect !== a.p_redirect_uri || c.challenge !== a.p_challenge) {
      c.used = true; this.revoke(c.grant); return bad;
    }
    if (a.p_resource !== c.resource) return { ok: false, error: "invalid_target" };
    if (!this.entitled) return { ok: false, error: "subscription_required" };
    c.used = true;
    const g = this.grants.get(c.grant)!;
    g.activated = true;
    this.tokens.set(a.p_access_hash, { grant: g.id, kind: "access", expires: this.now + 3600, used: false, revoked: false });
    this.tokens.set(a.p_refresh_hash, { grant: g.id, kind: "refresh", expires: this.now + 30 * 86400, used: false, revoked: false });
    return { ok: true, scope: g.scopes.join(" "), expires_in: 3600, resource: g.resource };
  }

  oauth_refresh(a: Record<string, string>) {
    const bad = { ok: false, error: "invalid_grant" };
    const t = this.tokens.get(a.p_refresh_hash);
    if (!t || t.kind !== "refresh") return bad;
    const g = this.grants.get(t.grant)!;
    if (g.clientId !== a.p_client_id) return bad;
    if (t.used) { this.revoke(g.id); return bad; }
    if (t.revoked || g.revoked || t.expires < this.now) return bad;
    if (!this.entitled) return { ok: false, error: "subscription_required" };
    t.used = true;
    for (const x of this.tokens.values()) if (x.grant === g.id && x.kind === "access") x.revoked = true;
    this.tokens.set(a.p_new_access_hash, { grant: g.id, kind: "access", expires: this.now + 3600, used: false, revoked: false });
    this.tokens.set(a.p_new_refresh_hash, { grant: g.id, kind: "refresh", expires: this.now + 30 * 86400, used: false, revoked: false });
    return { ok: true, scope: g.scopes.join(" "), expires_in: 3600, resource: g.resource };
  }

  oauth_revoke_token(a: Record<string, string>) {
    const t = this.tokens.get(a.p_token_hash);
    const g = t && this.grants.get(t.grant);
    if (g && g.clientId === a.p_client_id) this.revoke(g.id);
    return null;
  }

  private live(hash: string) {
    const t = this.tokens.get(hash);
    const g = t && this.grants.get(t.grant);
    if (!t || !g || t.kind !== "access" || t.revoked || t.expires < this.now || g.revoked || !g.activated) return null;
    return g;
  }

  oauth_check(a: Record<string, string>) {
    const g = this.live(a.p_token_hash);
    if (!g) return { ok: false, status: 401, error: { code: "invalid_token", message: "no" } };
    return { ok: true, status: 200, data: { resource: g.resource, scopes: g.scopes, entitled: this.entitled } };
  }

  /** What api_begin -> oauth_ctx answers for any endpoint an access token may reach. */
  private begun(hash: string, scope: string) {
    const g = this.live(hash);
    if (!g) return { err: { ok: false, status: 401, error: { code: "invalid_api_key", message: "no" } } };
    if (!this.entitled) return { err: { ok: false, status: 403, error: { code: "subscription_required", message: "paused" } } };
    if (!g.scopes.includes(scope)) return { err: { ok: false, status: 403, error: { code: "insufficient_scope", message: "no", required_scope: scope } } };
    return { g };
  }

  api_list_channels(a: Record<string, string>) {
    const b = this.begun(a.p_key_hash, "videos:read");
    return b.err ?? { ok: true, status: 200, data: { channels: [{ id: "e2e-channel" }] } };
  }

  oauth_get_balance(a: Record<string, string>) {
    const b = this.begun(a.p_token_hash, "videos:read");
    if (b.err) return b.err;
    return { ok: true, status: 200, data: { credits: { available: this.credits.available, held: this.credits.held },
      this_connection: { monthly_limit_credits: b.g!.limit, spent_this_month_credits: this.spent } } };
  }

  oauth_create_video(a: Record<string, unknown>) {
    const b = this.begun(a.p_token_hash as string, "videos:create");
    if (b.err) return b.err;
    const price = 90;
    if (this.spent + price > b.g!.limit)
      return { ok: false, status: 402, error: { code: "connection_limit_reached", message: "limit", limit_credits: b.g!.limit, spent_credits: this.spent, price_credits: price } };
    if (this.active >= this.runLimit)
      return { ok: false, status: 429, error: { code: "run_limit_reached", message: "busy", retry_after: 60, active_runs: this.active, run_limit: this.runLimit } };
    if (this.credits.available < price)
      return { ok: false, status: 402, error: { code: "insufficient_credits", message: "short", available_credits: this.credits.available, held_credits: this.credits.held, price_credits: price } };
    this.credits.available -= price; this.credits.held += price; this.spent += price; this.active += 1;
    return { ok: true, status: 201, data: { job_id: 1, channel_id: a.p_channel_id, status: "queued", price_credits: price } };
  }

  // The USD-balance functions: reaching one with a token is a failure of the design.
  api_create_video() { this.usdTouched = true; return { ok: true, status: 201, data: {} }; }
  api_balance() { this.usdTouched = true; return { ok: true, status: 200, data: {} }; }
  api_request_download() { this.usdTouched = true; return { ok: true, status: 201, data: {} }; }
  api_get_download() { this.usdTouched = true; return { ok: true, status: 200, data: {} }; }
  api_auth() { this.usdTouched = true; return { ok: true, status: 200, data: {} }; }
}
