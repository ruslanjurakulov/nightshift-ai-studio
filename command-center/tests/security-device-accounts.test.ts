import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Breach: attacks on the accounts kept on one device (PR #859: bc042e8a, then the review fixes d6398166 / daf5285f;
 * lib/device-accounts.ts, lib/server/device-accounts.ts, app/api/account/accounts/*, lib/device-accounts-client.ts).
 * The database half (audit_account_switch, migration 0204) is tests/security/test_sec_breach_account_switch_0204.py.
 *
 * Lab only: every Supabase call is a mock in this file (no network, no real project, no real account). The tokens below
 * are made-up strings.
 *
 * Layout:
 * - "OPEN" blocks would be holes that still exist (none at this commit).
 *   (vitest reports it as an expected failure); when the fix lands `it.fails` turns red, the signal to flip it to `it`.
 * - "FIXED" blocks were holes at bc042e8a, now closed; they are plain tests so a regression is loud.
 * - "REFUSED" blocks are attacks the change stopped from the start.
 */
vi.mock("server-only", () => ({}));

type Cookie = { name: string; value: string; options?: Record<string, unknown> };
type FakeUser = { id: string; email: string; factors?: Array<{ status: string; factor_type: string }>; user_metadata?: Record<string, unknown> };

const h = vi.hoisted(() => ({
  jar: new Map<string, Cookie>(),
  active: null as null | FakeUser,
  activeRt: "rt-active-SECRET",
  setSession: [] as Array<{ access_token: string; refresh_token: string }>,
  setSessionFails: false,
  statelessSetSession: [] as Array<{ access_token: string; refresh_token: string }>,
  signOuts: [] as Array<unknown>,
  signOutError: false,
  refreshCalls: [] as string[],
  refresh: new Map<string, { user?: FakeUser; aal?: string; status?: number; throws?: boolean }>(),
  rpcs: [] as Array<{ fn: string; args: Record<string, unknown>; bearer: boolean }>,
  rpcError: null as null | { code: string; message: string },
  stopAutoRefresh: 0,
}));

function jwt(aal: string, sub = "x") {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256" })}.${b({ aal, sub })}.sig`;
}

vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://lab.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => h.jar.get(name),
    getAll: () => [...h.jar.values()],
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      if (options && typeof options.maxAge === "number" && options.maxAge <= 0) h.jar.delete(name);
      else h.jar.set(name, { name, value, options });
    },
  }),
  headers: async () => new Headers(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => h.active,
  // The held client (activeSession) is the same fake client; its cookie writes are applied by commit(), a no-op here.
  createHeldClient: async () => ({ client: await (await import("@/lib/supabase/server")).createClient(), commit: () => undefined }),
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: h.active }, error: h.active ? null : { status: 400, message: "no user" } }),
      getSession: async () => ({ data: { session: h.active ? { access_token: jwt("aal2", h.active.id), refresh_token: h.activeRt } : null } }),
      setSession: async (s: { access_token: string; refresh_token: string }) => {
        if (h.setSessionFails) return { error: { message: "nope" } };
        h.setSession.push(s);
        return { error: null };
      },
    },
  }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, opts?: { global?: { headers?: Record<string, string> } }) => ({
    auth: {
      refreshSession: async ({ refresh_token }: { refresh_token: string }) => {
        h.refreshCalls.push(refresh_token);
        const a = h.refresh.get(refresh_token);
        if (!a) return { data: { session: null, user: null }, error: { status: 400, message: "Invalid Refresh Token" } };
        if (a.throws) throw new Error("network");
        if (a.status) return { data: { session: null, user: null }, error: { status: a.status, message: "x" } };
        return {
          data: { session: { access_token: jwt(a.aal ?? "aal1", a.user?.id), refresh_token: `${refresh_token}-rotated` }, user: a.user },
          error: null,
        };
      },
      setSession: async (s: { access_token: string; refresh_token: string }) => {
        h.statelessSetSession.push(s);
        return { error: null };
      },
      signOut: async (o: unknown) => {
        h.signOuts.push(o);
        return h.signOutError ? { error: { status: 503, message: "auth down" } } : { error: null };
      },
    },
    // supabase-js never THROWS on a refused call: it RESOLVES with { error }. That is the real behaviour mocked here.
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcs.push({ fn, args, bearer: Boolean(opts?.global?.headers?.Authorization) });
      return { data: null, error: h.rpcError };
    },
  }),
}));

// The sign-in layout's other imports: replaced by stand-ins so its RSC tree can be inspected as data.
vi.mock("@/lib/i18n/server", () => ({ getDictionary: async () => ({ t: {}, locale: "en" }) }));
vi.mock("@/lib/landing", () => ({ runtimeSiteOrigin: () => "http://localhost", shareMetadata: () => ({}) }));
vi.mock("@/components/auth/GoogleEnabled", () => ({ GoogleEnabled: (p: { children: unknown }) => p.children }));

// Hooks are called as plain functions here: an effect runs its body at once, so a listener can be driven directly.
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (fn: () => void) => void fn() }));
// The browser helpers' local-storage cleanup and browser Supabase client are not what is attacked here.
vi.mock("@/lib/create-attempt-store", () => ({ clearAllCreateAttempts: () => undefined }));
vi.mock("@/lib/create-draft", () => ({ clearAllDrafts: () => undefined }));
vi.mock("@/lib/editor-draft-store", () => ({ clearAllEditorDrafts: () => undefined }));
vi.mock("@/lib/site/pending-attachment", () => ({ discardPendingAtSignOut: async () => undefined }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { stopAutoRefresh: async () => void (h.stopAutoRefresh += 1) } }),
}));

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // the victim, active
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // the victim's second account
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const X = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"; // the attacker

const lib = await import("@/lib/server/device-accounts");
const paths = await import("@/lib/public-paths");
const ownerMode = await import("@/lib/owner-mode");
const { POST: SWITCH } = await import("../app/api/account/accounts/switch/route");
const { POST: ADD } = await import("../app/api/account/accounts/add/route");
const { POST: LOGOUT } = await import("../app/api/account/accounts/logout/route");
const { GET: LIST } = await import("../app/api/account/accounts/route");
const { default: LoginLayout } = await import("../app/login/layout");

const ORIGIN = "http://localhost";
const SWITCH_URL = "/api/account/accounts/switch";
const ADD_URL = "/api/account/accounts/add";
const LOGOUT_URL = "/api/account/accounts/logout";
const HOME = "/all-channels";
const OUTGOING_ROTATED = "rt-active-SECRET-rotated";

function post(p: string, body: unknown, headers: Record<string, string | null> = { origin: ORIGIN }) {
  const hs: Record<string, string> = { "content-type": "application/json" };
  for (const [k, v] of Object.entries(headers)) if (v !== null) hs[k] = v;
  return new Request(`${ORIGIN}${p}`, { method: "POST", headers: hs, body: typeof body === "string" ? body : JSON.stringify(body) });
}

const nonceOf = (slot: 1 | 2) => `${slot}`.repeat(16);
function park(slot: 1 | 2, uid: string, email: string, rt: string, extra: Record<string, unknown> = {}) {
  h.jar.set(lib.parkedCookieName(slot), {
    name: lib.parkedCookieName(slot),
    value: lib.encodeParked({ uid, email, name: null, rt, iat: 1_700_000_000, nonce: nonceOf(slot), ...extra }),
  });
}
function rawCookie(name: string, obj: unknown) {
  h.jar.set(name, { name, value: Buffer.from(JSON.stringify(obj), "utf8").toString("base64url") });
}
const at = (slot: 1 | 2) => ({ slot, nonce: slotOf(slot)?.nonce ?? nonceOf(slot) });
const slotOf = (slot: 1 | 2) => lib.decodeParked(h.jar.get(lib.parkedCookieName(slot))?.value);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  h.jar.clear();
  h.active = { id: A, email: "victim.a@lab.test" };
  h.activeRt = "rt-active-SECRET";
  h.setSession = [];
  h.setSessionFails = false;
  h.statelessSetSession = [];
  h.signOuts = [];
  h.signOutError = false;
  h.refreshCalls = [];
  h.refresh.clear();
  h.refresh.set(h.activeRt, { user: { id: A, email: "victim.a@lab.test" }, aal: "aal2" });
  h.rpcs = [];
  h.rpcError = null;
  h.stopAutoRefresh = 0;
  h.jar.set("sb-lab-auth-token", { name: "sb-lab-auth-token", value: "active-session" });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// OPEN
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("FIXED [medium] a failed switch never spends the OUTGOING account's refresh token", () => {
  // At bc042e8a+1 the route refreshed the active account's token before it knew the target could be switched to, and on a
  // refusal the new token was written nowhere: the active cookie held a spent token, and the next refresh read as reuse.
  // Now the outgoing account is refreshed only AFTER the target is active; on every refusal its token is never touched.
  beforeEach(() => park(1, B, "b@lab.test", "rt-b"));

  it("sanity: on success the target is refreshed first, then the outgoing account, whose rotated token is parked", async () => {
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
    expect((await SWITCH(post(SWITCH_URL, at(1)))).status).toBe(200);
    expect(h.refreshCalls).toEqual(["rt-b", "rt-active-SECRET"]);
    expect(slotOf(1)).toMatchObject({ uid: A, rt: OUTGOING_ROTATED });
  });

  it("target session expired (409): the outgoing token is never refreshed", async () => {
    expect((await SWITCH(post(SWITCH_URL, at(1)))).status).toBe(409);
    expect(h.refreshCalls).not.toContain("rt-active-SECRET");
  });

  it("auth server fails on the target (503): the outgoing token is never refreshed", async () => {
    h.refresh.set("rt-b", { status: 502 });
    expect((await SWITCH(post(SWITCH_URL, at(1)))).status).toBe(503);
    expect(h.refreshCalls).not.toContain("rt-active-SECRET");
  });

  it("account_mismatch (409): the outgoing token is never refreshed", async () => {
    h.refresh.set("rt-b", { user: { id: X, email: "attacker@evil.test" } });
    expect((await SWITCH(post(SWITCH_URL, at(1)))).status).toBe(409);
    expect(h.refreshCalls).not.toContain("rt-active-SECRET");
  });

  it("activate fails (503): the outgoing token is never refreshed", async () => {
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
    h.setSessionFails = true;
    expect((await SWITCH(post(SWITCH_URL, at(1)))).status).toBe(503);
    expect(h.refreshCalls).not.toContain("rt-active-SECRET");
  });
});

/** Every module a file pulls in through `@/` and relative imports, to a depth, as source text. */
function importGraph(entry: string, depth = 5, seen = new Set<string>()): string[] {
  const root = process.cwd();
  const resolve = (spec: string, from: string): string | null => {
    const base = spec.startsWith("@/") ? path.join(root, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
    if (!base) return null;
    for (const ext of ["", ".tsx", ".ts", "/index.tsx", "/index.ts"]) if (existsSync(base + ext) && !base.endsWith("/") && (ext || /\.[jt]sx?$/.test(base))) return base + ext;
    return null;
  };
  if (seen.has(entry) || depth < 0) return [];
  seen.add(entry);
  const src = readFileSync(entry, "utf8");
  const out = [src];
  for (const m of src.matchAll(/from\s+["']([^"']+)["']/g)) {
    const next = resolve(m[1]!, entry);
    if (next) out.push(...importGraph(next, depth - 1, seen));
  }
  return out;
}

describe("FIXED [low-medium] signed-in pages outside the app frame hear the tab broadcast (root layout)", () => {
  // useDeviceAccountsSync is mounted in AccountMenu and OwnerShell only. /welcome draws neither, and it POSTs the 18+
  // attestation (/api/account/age, AgeGate) and creates an organization (/api/org/create, WelcomeFlow). A /welcome tab of
  // account A left open while another tab switches to B submits both as B. Fix: mount the listener once in the root
  // layout (or a provider every signed-in frame has), not per component.
  it("sanity: the root layout mounts the listener once, for every tab", () => {
    expect(importGraph(path.join(process.cwd(), "app/layout.tsx"), 2).join("\n")).toContain("useDeviceAccountsSync()");
  });

  it("/welcome (age attestation, organization creation) reloads when another tab switches account", () => {
    const tree = [path.join(process.cwd(), "app/welcome/page.tsx"), path.join(process.cwd(), "app/welcome/layout.tsx"), path.join(process.cwd(), "app/layout.tsx")]
      .flatMap((f) => importGraph(f))
      .join("\n");
    expect(tree).toMatch(/useDeviceAccountsSync\(\)/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// FIXED (holes found at bc042e8a, closed by the review fixes)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The newest migration's audit_action_allowed(), evaluated in JS: the literal list plus its `~` regexes. */
function databaseAllowsAction(action: string): boolean {
  const dir = path.resolve(process.cwd(), "..", "supabase", "migrations");
  const defining = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => readFileSync(path.join(dir, f), "utf8").includes("create or replace function public.audit_action_allowed"));
  const text = readFileSync(path.join(dir, defining[defining.length - 1]!), "utf8");
  const fn = text.slice(text.indexOf("create or replace function public.audit_action_allowed"));
  const body = fn.slice(0, fn.indexOf("$$;", fn.indexOf("$$") + 2));
  const list = body.slice(body.indexOf("array["), body.indexOf("]::text[]"));
  const literals = new Set([...list.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]));
  const regexes = [...body.matchAll(/~\s*'([^']+)'/g)].map((m) => new RegExp(m[1]!));
  return literals.has(action) || regexes.some((r) => r.test(action));
}

describe("FIXED [was M1] the account.switch audit row: allowed, written through the definer function, failures logged", () => {
  it("sanity: the parser reads the real allow-list", () => {
    expect(databaseAllowsAction("api_key.create")).toBe(true);
    expect(databaseAllowsAction("breach.made_up")).toBe(false);
  });

  it("the database's audit_action_allowed() accepts 'account.switch'", () => {
    expect(databaseAllowsAction("account.switch")).toBe(true);
  });

  it("the route names only where it came FROM, as the new account's own bearer (the database names the arrival)", async () => {
    park(1, B, "b@lab.test", "rt-b");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
    await SWITCH(post(SWITCH_URL, at(1)));
    expect(h.rpcs).toEqual([{ fn: "audit_account_switch", args: { p_from: A }, bearer: true }]);
    expect(JSON.stringify(h.rpcs)).not.toMatch(/rt-|SECRET|@|eyJ/);
  });

  it("a refused audit write is reported (console.error), and the switch still answers", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      h.rpcError = { code: "54000", message: "too many account switches" };
      park(1, B, "b@lab.test", "rt-b");
      h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
      expect((await SWITCH(post(SWITCH_URL, at(1)))).status).toBe(200);
      expect(err).toHaveBeenCalled();
      expect(JSON.stringify(err.mock.calls)).not.toMatch(/rt-|SECRET|eyJ/);
    } finally {
      err.mockRestore();
    }
  });
});

describe("FIXED [was M2] logout says when the session was NOT ended at the auth server", () => {
  it("baseline: with the auth server up, logout refreshes that slot's token and ends THAT session (scope local)", async () => {
    park(1, B, "b@lab.test", "rt-b");
    park(2, C, "c@lab.test", "rt-c");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
    h.refresh.set("rt-c", { user: { id: C, email: "c@lab.test" } });
    const one = await LOGOUT(post(LOGOUT_URL, at(1)));
    expect(await one.json()).toEqual({ ok: true, revoked: true });
    expect(h.refreshCalls).toEqual(["rt-b"]);
    expect(h.statelessSetSession).toEqual([expect.objectContaining({ refresh_token: "rt-b-rotated" })]);
    expect(h.signOuts).toEqual([{ scope: "local" }]);
    expect(slotOf(2)).toMatchObject({ uid: C });
    expect(h.jar.has("sb-lab-auth-token")).toBe(true);
    park(1, B, "b@lab.test", "rt-b");
    h.signOuts = [];
    expect(await (await LOGOUT(post(LOGOUT_URL, { all: true }))).json()).toEqual({ ok: true, unrevoked: 0 });
    expect(h.signOuts).toHaveLength(2);
    expect(slotOf(1)).toBeNull();
    expect(slotOf(2)).toBeNull();
  });

  it("auth server down (network error): cookie removed, answer says revoked:false", async () => {
    park(1, B, "b@lab.test", "rt-b");
    h.refresh.set("rt-b", { throws: true });
    const json = await (await LOGOUT(post(LOGOUT_URL, at(1)))).json();
    expect(slotOf(1)).toBeNull();
    expect(h.signOuts).toHaveLength(0);
    expect(json).toEqual({ ok: true, revoked: false });
  });

  it("auth server errors on the final signOut: revoked:false", async () => {
    park(1, B, "b@lab.test", "rt-b");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
    h.signOutError = true;
    expect(await (await LOGOUT(post(LOGOUT_URL, at(1)))).json()).toEqual({ ok: true, revoked: false });
  });

  it("'Log out of all' during an outage counts the sessions it could not end", async () => {
    park(1, B, "b@lab.test", "rt-b");
    park(2, C, "c@lab.test", "rt-c");
    h.refresh.set("rt-b", { status: 503 });
    h.refresh.set("rt-c", { throws: true });
    const json = await (await LOGOUT(post(LOGOUT_URL, { all: true }))).json();
    expect(slotOf(1)).toBeNull();
    expect(slotOf(2)).toBeNull();
    expect(json).toEqual({ ok: true, unrevoked: 2 });
  });

  it("a row already refused by the auth server is reported as over (revoked:true), not as a live leftover", async () => {
    park(1, B, "b@lab.test", "rt-gone", { stale: true });
    expect(await (await LOGOUT(post(LOGOUT_URL, at(1)))).json()).toEqual({ ok: true, revoked: true });
    expect(h.refreshCalls).toEqual(["rt-gone"]); // the revoke is attempted even for a stale row
  });
});

describe("FIXED [was L1] a rate limit or timeout is 'try again', not 'session expired'", () => {
  for (const status of [429, 408, 500, 502]) {
    it(`a ${status} on switch answers 503 and leaves the row as it was`, async () => {
      park(1, B, "b@lab.test", "rt-b");
      h.refresh.set("rt-b", { status });
      expect((await SWITCH(post(SWITCH_URL, at(1)))).status).toBe(503);
      expect(slotOf(1)?.stale).toBeUndefined();
      expect(slotOf(1)?.rt).toBe("rt-b");
    });
  }
});

describe("FIXED [was L2] a parked token is ended before it is overwritten or dropped", () => {
  it("'Add account' reusing the active account's old parked copy ends that copy's session first", async () => {
    park(1, A, "victim.a@lab.test", "rt-old-a");
    h.refresh.set("rt-old-a", { user: { id: A, email: "victim.a@lab.test" } });
    expect((await ADD(post(ADD_URL, {}))).status).toBe(200);
    expect(slotOf(1)).toMatchObject({ uid: A, rt: OUTGOING_ROTATED });
    expect(h.refreshCalls).toContain("rt-old-a");
    expect(h.signOuts.length).toBeGreaterThan(0);
  });

  it("a switch to a slot that already is the active account ends that duplicate and answers {same:true}", async () => {
    park(1, A, "victim.a@lab.test", "rt-dup-a");
    h.refresh.set("rt-dup-a", { user: { id: A, email: "victim.a@lab.test" } });
    expect(await (await SWITCH(post(SWITCH_URL, at(1)))).json()).toMatchObject({ same: true });
    expect(slotOf(1)).toBeNull();
    expect(h.refreshCalls).toEqual(["rt-dup-a"]); // the ACTIVE session is not touched
    expect(h.jar.get("sb-lab-auth-token")?.value).toBe("active-session");
  });

  it("account_mismatch: the session the auth server handed back is ended, not left live", async () => {
    park(1, B, "b@lab.test", "rt-attacker");
    h.refresh.set("rt-attacker", { user: { id: X, email: "attacker@evil.test" } });
    expect((await SWITCH(post(SWITCH_URL, at(1)))).status).toBe(409);
    expect(h.statelessSetSession).toEqual([expect.objectContaining({ refresh_token: "rt-attacker-rotated" })]);
    expect(h.signOuts).toEqual([{ scope: "local" }]);
  });
});

/** The browser half, run in node with the browser globals it touches stubbed. */
async function clientWith(answer: Record<string, unknown>, opts: { locks?: boolean } = {}) {
  const assign = vi.fn();
  const posted: unknown[] = [];
  const bodies: unknown[] = [];
  const lockNames: string[] = [];
  vi.stubGlobal("window", { location: { assign, origin: "https://app.lab.test", reload: vi.fn() } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init?: { body?: string }) => {
      bodies.push(init?.body ? JSON.parse(init.body) : null);
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage: ((e: MessageEvent) => void) | null = null;
      constructor(public name: string) {}
      postMessage(m: unknown) {
        posted.push({ name: this.name, m });
      }
      close() {}
    },
  );
  vi.stubGlobal("navigator", opts.locks ? { locks: { request: async (name: string, fn: () => Promise<unknown>) => (lockNames.push(name), fn()) } } : {});
  const client = await import("@/lib/device-accounts-client");
  return { client, assign, posted, bodies, lockNames };
}

describe("FIXED [was L3] the client's same-path check keeps every `to` on the origin", () => {
  for (const to of ["/\\evil.example/phish", "/\\/evil.example", "//evil.example", "https://evil.example", "javascript:alert(1)", "/%5Cevil.example"]) {
    it(`${JSON.stringify(to)} stays on the origin`, async () => {
      const { client } = await clientWith({});
      const out = client.samePath(to);
      expect(new URL(out, "https://app.lab.test").origin).toBe("https://app.lab.test");
    });
  }

  it("a real switch follows the server's path, never off-site", async () => {
    const { client, assign } = await clientWith({ to: "/\\evil.example" });
    await client.switchAccount({ slot: 1, nonce: nonceOf(1) });
    expect(assign).toHaveBeenCalledWith("/");
  });
});

describe("FIXED [was M3] other tabs are told about a switch, an add and a logout", () => {
  it("switch: stops this tab's refresh first, sends {slot, nonce}, runs under the cross-tab lock, then broadcasts", async () => {
    const { client, posted, bodies, lockNames } = await clientWith({ to: HOME }, { locks: true });
    expect(await client.switchAccount({ slot: 1, nonce: nonceOf(1) })).toEqual({ ok: true });
    expect(h.stopAutoRefresh).toBe(1);
    expect(bodies).toEqual([{ slot: 1, nonce: nonceOf(1) }]);
    expect(lockNames).toEqual(["ns-device-accounts"]);
    expect(posted).toEqual([{ name: "ns-device-accounts", m: { type: "changed", from: expect.any(String) } }]);
  });

  it("the broadcast carries no account data, only 'changed' and a tab id", async () => {
    const { client, posted } = await clientWith({ to: HOME });
    await client.addAccount();
    await client.logOutParked({ slot: 1, nonce: nonceOf(1) });
    expect(posted).toHaveLength(2);
    expect(JSON.stringify(posted)).not.toMatch(/@|rt-|[0-9a-f]{8}-[0-9a-f]{4}|nonce|slot/);
  });

  it("a listening tab reloads on another tab's message and ignores its own and malformed ones", async () => {
    const { client } = await clientWith({});
    const listeners: Array<{ onmessage: ((e: MessageEvent) => void) | null }> = [];
    vi.stubGlobal(
      "BroadcastChannel",
      class {
        onmessage: ((e: MessageEvent) => void) | null = null;
        constructor() {
          listeners.push(this);
        }
        postMessage() {}
        close() {}
      },
    );
    client.useDeviceAccountsSync(); // react's useEffect runs its body at once in this file (vi.mock("react") above)
    const reload = (globalThis as unknown as { window: { location: { reload: ReturnType<typeof vi.fn> } } }).window.location.reload;
    const fire = (data: unknown) => listeners[0]!.onmessage!({ data } as MessageEvent);
    fire({ type: "nope", from: "other" });
    fire(null);
    expect(reload).not.toHaveBeenCalled();
    fire({ type: "changed", from: "another-tab" });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// REFUSED: the new slot nonce (a precondition, not a secret)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("REFUSED: nonce forgery and replay", () => {
  beforeEach(() => {
    park(1, B, "b@lab.test", "rt-b");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
  });

  it("a request without a nonce, or with a malformed one, is 400 on switch, logout and add-replace, with nothing touched", async () => {
    for (const nonce of [undefined, "", "1".repeat(15), "1".repeat(17), "G".repeat(16), "AAAAAAAAAAAAAAAA", 1111111111111111, ["1111111111111111"]]) {
      expect((await SWITCH(post(SWITCH_URL, { slot: 1, nonce }))).status, String(nonce)).toBe(400);
      expect((await LOGOUT(post(LOGOUT_URL, { slot: 1, nonce }))).status, String(nonce)).toBe(400);
      expect((await ADD(post(ADD_URL, { replace: 1, nonce }))).status, String(nonce)).toBe(400);
    }
    expect(h.refreshCalls).toHaveLength(0);
    expect(slotOf(1)).toMatchObject({ uid: B, rt: "rt-b" });
  });

  it("a well-formed guessed nonce is 409 slot_changed before the auth server is asked", async () => {
    for (const r of [
      () => SWITCH(post(SWITCH_URL, { slot: 1, nonce: "0123456789abcdef" })),
      () => LOGOUT(post(LOGOUT_URL, { slot: 1, nonce: "0123456789abcdef" })),
      () => ADD(post(ADD_URL, { replace: 1, nonce: "0123456789abcdef" })),
    ]) {
      const res = await r();
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("slot_changed");
    }
    expect(h.refreshCalls).toHaveLength(0);
    expect(slotOf(1)).toMatchObject({ uid: B });
  });

  it("replaying a switch after it happened names the old occupant and is refused (the slot got a new nonce)", async () => {
    const first = post(SWITCH_URL, at(1));
    const replay = { ...at(1) };
    expect((await SWITCH(first)).status).toBe(200);
    expect(slotOf(1)).toMatchObject({ uid: A });
    expect(slotOf(1)!.nonce).not.toBe(replay.nonce);
    expect(slotOf(1)!.nonce).toMatch(/^[0-9a-f]{16}$/);
    // The person (now B) replays the old request: it must not switch back to A without naming A's new nonce.
    h.active = { id: B, email: "b@lab.test" };
    h.activeRt = "rt-b-rotated";
    h.refresh.set("rt-b-rotated", { user: { id: B, email: "b@lab.test" } });
    h.setSession = [];
    const res = await SWITCH(post(SWITCH_URL, replay));
    expect(res.status).toBe(409);
    expect(h.setSession).toHaveLength(0);
  });

  it("nonces are fresh per park: two parks of the same account never share one", () => {
    const seen = new Set(Array.from({ length: 200 }, () => lib.parkedFrom({ id: A, email: "a@x.y", user_metadata: {} } as never, "rt").nonce));
    expect(seen.size).toBe(200);
  });

  it("a cookie without a nonce (the bc042e8a format) is not one of ours: never acted on, removed by the list", async () => {
    rawCookie(lib.parkedCookieName(2), { v: 1, uid: C, email: "c@lab.test", name: null, rt: "rt-c", iat: 1 });
    expect(lib.readParked({ get: (n) => h.jar.get(n) }).has(2)).toBe(false);
    expect((await SWITCH(post(SWITCH_URL, { slot: 2, nonce: nonceOf(2) }))).status).toBe(404);
    await LIST();
    expect(h.jar.has(lib.parkedCookieName(2))).toBe(false);
    expect(h.refreshCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// REFUSED
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("REFUSED: CSRF on every POST", () => {
  const routes = [
    ["switch", SWITCH, SWITCH_URL, { slot: 1, nonce: nonceOf(1) }],
    ["add", ADD, ADD_URL, {}],
    ["logout one", LOGOUT, LOGOUT_URL, { slot: 1, nonce: nonceOf(1) }],
    ["logout all", LOGOUT, LOGOUT_URL, { all: true }],
  ] as const;
  const hostile: Array<[string, Record<string, string | null>]> = [
    ["foreign Origin", { origin: "https://evil.example" }],
    ["Origin null (sandboxed iframe, data: URL)", { origin: "null" }],
    ["no Origin at all", { origin: null }],
    ["no Origin, Sec-Fetch-Site same-origin (no allowMissing option on these routes)", { origin: null, "sec-fetch-site": "same-origin" }],
    ["sibling host Origin", { origin: "http://evil.localhost" }],
    ["our Origin but Sec-Fetch-Site cross-site", { origin: ORIGIN, "sec-fetch-site": "cross-site" }],
    ["our Origin but Sec-Fetch-Site same-site", { origin: ORIGIN, "sec-fetch-site": "same-site" }],
    ["other port on localhost", { origin: "http://localhost:4000" }],
  ];
  for (const [name, handler, url, body] of routes) {
    for (const [why, headers] of hostile) {
      it(`${name}: ${why} -> 403, nothing read or written`, async () => {
        park(1, B, "b@lab.test", "rt-b");
        h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
        const before = JSON.stringify([...h.jar.entries()]);
        const res = await handler(post(url, body, headers));
        expect(res.status).toBe(403);
        expect(JSON.stringify([...h.jar.entries()])).toBe(before);
        expect(h.refreshCalls).toHaveLength(0);
        expect(h.setSession).toHaveLength(0);
      });
    }
  }

  it("a text/plain 'simple' cross-site form POST is refused on Origin like any other", async () => {
    park(1, B, "b@lab.test", "rt-b");
    const req = new Request(`${ORIGIN}${SWITCH_URL}`, { method: "POST", headers: { "content-type": "text/plain", origin: "https://evil.example" }, body: JSON.stringify(at(1)) });
    expect((await SWITCH(req)).status).toBe(403);
  });
});

describe("REFUSED: session fixation / login CSRF through a planted parked cookie", () => {
  it("a cookie naming the victim's uid with the attacker's refresh token is refused (account_mismatch) and dropped", async () => {
    park(1, B, "b@lab.test", "rt-attacker");
    h.refresh.set("rt-attacker", { user: { id: X, email: "attacker@evil.test" } });
    const res = await SWITCH(post(SWITCH_URL, at(1)));
    expect(res.status).toBe(409);
    expect(h.setSession).toHaveLength(0);
    expect(slotOf(1)).toBeNull();
  });

  // Documented reliance, not a hole in production: a planted cookie that is CONSISTENT (the attacker's uid with the
  // attacker's token, and any nonce, which the attacker chose) passes every check and is switched into. Only the __Host-
  // prefix (production) keeps a sibling host or another localhost port from planting one. In `next dev` the name is bare
  // `ns_acct_1`, and cookies are not port-isolated [low, dev only].
  it("a consistent attacker cookie is accepted by the uid check: __Host- is the only line, and it is on in production", async () => {
    park(1, X, "attacker@evil.test", "rt-attacker");
    h.refresh.set("rt-attacker", { user: { id: X, email: "attacker@evil.test" } });
    expect((await SWITCH(post(SWITCH_URL, at(1)))).status).toBe(200);
    expect(lib.parkedCookieName(1, true)).toBe("__Host-ns_acct_1");
    expect(lib.parkedCookieName(2, true)).toBe("__Host-ns_acct_2");
    expect(lib.parkedCookieOptions(true)).toMatchObject({ secure: true, path: "/", httpOnly: true });
    expect(lib.parkedCookieOptions(true)).not.toHaveProperty("domain");
  });

  it("in production an unprefixed ns_acct_1 (what a sibling host or http page could set) is never read", () => {
    vi.stubEnv("NODE_ENV", "production");
    rawCookie("ns_acct_1", { v: 1, uid: X, email: "attacker@evil.test", name: null, rt: "rt-attacker", iat: 1, n: nonceOf(1) });
    rawCookie("ns_acct_2", { v: 1, uid: X, email: "attacker@evil.test", name: null, rt: "rt-attacker", iat: 1, n: nonceOf(2) });
    expect(lib.readParked({ get: (n) => h.jar.get(n) }).size).toBe(0);
  });

  it("a cross-site link to /login?add=1 switches nobody: the page only lists, a switch needs a same-origin POST", () => {
    const src = readFileSync(path.resolve(process.cwd(), "components/auth/SavedAccounts.tsx"), "utf8");
    expect(src).not.toMatch(/useEffect\([^)]*switchAccount/s);
  });
});

describe("REFUSED: cookie tampering", () => {
  const ok = { v: 1, uid: B, rt: "rt", iat: 1, n: nonceOf(1) };

  it("prototype keys do not smuggle fields in", () => {
    const proto = `{"__proto__":${JSON.stringify(ok)}}`;
    expect(lib.decodeParked(Buffer.from(proto).toString("base64url"))).toBeNull();
    const ctor = lib.decodeParked(b64({ ...ok, constructor: { prototype: { stale: true } }, toString: 1 }));
    expect(ctor).toEqual({ uid: B, email: null, name: null, rt: "rt", iat: 1, nonce: nonceOf(1) });
    expect(({} as Record<string, unknown>).stale).toBeUndefined();
  });

  it("a version mismatch, a bad uid, rt, iat or nonce are dropped", () => {
    for (const bad of [
      { ...ok, v: 2 },
      { ...ok, v: "1" },
      { ...ok, uid: `${B}\n` },
      { ...ok, uid: "../../etc" },
      { ...ok, rt: "" },
      { ...ok, rt: "r".repeat(2049) },
      { ...ok, rt: ["x"] },
      { ...ok, iat: "1" },
      { ...ok, iat: null },
      { ...ok, n: undefined },
      { ...ok, n: "ABCDEF0123456789" },
      { ...ok, n: "1".repeat(17) },
    ]) {
      expect(lib.decodeParked(b64(bad)), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
  });

  it("an oversized cookie is dropped before it is decoded, and a long name or email is not shown", () => {
    expect(lib.decodeParked("A".repeat(3601))).toBeNull();
    const p = lib.decodeParked(b64({ ...ok, name: "n".repeat(81), email: `${"e".repeat(320)}@x.y` }));
    expect(p).toMatchObject({ name: null, email: null });
  });

  it("only boolean stale counts, and a stale row is still verified on switch", async () => {
    expect(lib.decodeParked(b64({ ...ok, stale: "true" }))?.stale).toBeUndefined();
    park(1, B, "b@lab.test", "rt-b", { stale: true });
    h.refresh.set("rt-b", { user: { id: X, email: "attacker@evil.test" } });
    expect((await SWITCH(post(SWITCH_URL, at(1)))).status).toBe(409);
    expect(h.setSession).toHaveLength(0);
  });

  it("a third slot cookie and a slot named as a string/float/negative are ignored", async () => {
    rawCookie("ns_acct_3", { ...ok, uid: X, n: nonceOf(1) });
    rawCookie("ns_acct_0", { ...ok, uid: X, n: nonceOf(1) });
    expect(lib.readParked({ get: (n) => h.jar.get(n) }).size).toBe(0);
    for (const slot of ["1", 1.0000001, -1, 3, true, { valueOf: 1 }]) {
      expect((await SWITCH(post(SWITCH_URL, { slot, nonce: nonceOf(1) }))).status).toBe(400);
    }
  });

  it("an oversized body is refused before anything is read", async () => {
    park(1, B, "b@lab.test", "rt-b");
    const res = await SWITCH(post(SWITCH_URL, JSON.stringify({ ...at(1), pad: "x".repeat(20_000) })));
    expect(res.status).toBe(400);
    expect(h.refreshCalls).toHaveLength(0);
  });
});

describe("REFUSED: tokens and full addresses of other accounts never leave the server", () => {
  const TOKENS = /rt-|SECRET|eyJ|1700000000/;

  it("GET list, signed in and signed out: no token, no uid, no iat; a parked account's address masked", async () => {
    park(1, B, "b@lab.test", "rt-b");
    park(2, C, "c@lab.test", "rt-c", { stale: true });
    for (const active of [h.active, null]) {
      h.active = active;
      const body = JSON.stringify(await (await LIST()).json());
      expect(body).not.toMatch(TOKENS);
      expect(body).not.toMatch(/b@lab|c@lab/);
      expect(body).not.toContain(A);
      expect(body).not.toContain(B);
      expect(body).not.toContain(C);
    }
  });

  it("switch, add and logout answers carry no token, uid or address", async () => {
    park(1, B, "b@lab.test", "rt-b");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
    const bodies = [await (await SWITCH(post(SWITCH_URL, at(1)))).text()];
    h.active = { id: B, email: "b@lab.test" };
    h.activeRt = "rt-b-rotated";
    h.refresh.set("rt-b-rotated", { user: { id: B, email: "b@lab.test" } });
    h.jar.set("sb-lab-auth-token", { name: "sb-lab-auth-token", value: "active-session" });
    bodies.push(await (await ADD(post(ADD_URL, {}))).text());
    bodies.push(await (await LOGOUT(post(LOGOUT_URL, at(1)))).text());
    bodies.push(await (await LOGOUT(post(LOGOUT_URL, { all: true }))).text());
    park(1, C, "c@lab.test", "rt-gone");
    bodies.push(await (await SWITCH(post(SWITCH_URL, at(1)))).text());
    for (const b of bodies) {
      expect(b).not.toMatch(TOKENS);
      expect(b).not.toMatch(/@lab/);
      expect(b).not.toContain(A);
      expect(b).not.toContain(B);
    }
  });

  it("the /login layout's RSC tree carries only a boolean about the parked accounts", async () => {
    park(1, B, "b@lab.test", "rt-b");
    const tree = await LoginLayout({ children: null });
    const seen = JSON.stringify(tree, (_k, v) => (typeof v === "function" ? `[fn ${v.name}]` : v));
    expect(seen).not.toMatch(TOKENS);
    expect(seen).not.toMatch(/b@lab|nonce|1111111111111111/);
    expect(seen).toContain('"present":true');
  });

  it("the parked cookie is httpOnly in every environment", () => {
    expect(lib.parkedCookieOptions(false).httpOnly).toBe(true);
    expect(lib.parkedCookieOptions(true).httpOnly).toBe(true);
  });

  it("the browser Supabase client does not read a parked cookie as a session", async () => {
    const { createBrowserClient } = await vi.importActual<typeof import("@supabase/ssr")>("@supabase/ssr");
    const cookie = { name: lib.parkedCookieName(1, true), value: lib.encodeParked({ uid: B, email: "b@x.y", name: null, rt: "rt", iat: 1, nonce: nonceOf(1) }) };
    const client = createBrowserClient("https://lab.supabase.test", "anon", {
      isSingleton: false,
      cookies: { getAll: () => [cookie], setAll: () => undefined },
    });
    const { data } = await client.auth.getSession();
    expect(data.session).toBeNull();
  });
});

describe("REFUSED: cross-account leakage after a switch", () => {
  it("the active cookie gets the NEW account's session; the old one survives only inside its httpOnly slot", async () => {
    park(1, B, "b@lab.test", "rt-b");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
    await SWITCH(post(SWITCH_URL, at(1)));
    expect(h.setSession).toEqual([expect.objectContaining({ refresh_token: "rt-b-rotated" })]);
    const old = h.jar.get(lib.parkedCookieName(1))!;
    expect(old.options).toMatchObject({ httpOnly: true });
    expect(lib.decodeParked(old.value)).toMatchObject({ uid: A });
  });

  it("the previous account's channel and organization are not carried into the next one", async () => {
    h.jar.set("chronos_channel", { name: "chronos_channel", value: "victim-a-secret-channel" });
    h.jar.set("nightshift_org", { name: "nightshift_org", value: "org-of-a" });
    park(1, B, "b@lab.test", "rt-b");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
    expect(await (await SWITCH(post(SWITCH_URL, at(1)))).json()).toMatchObject({ to: HOME });
    expect(h.jar.get("chronos_channel")?.value).toBe("all-channels");
    expect(h.jar.has("nightshift_org")).toBe(false);
  });

  it("the owner frame follows the active account only: a leftover 'on' owner-mode cookie gives nothing to another account", () => {
    expect(ownerMode.ownerFrame(false, "on", false)).toBe(false);
    expect(ownerMode.ownerFrame(false, "on", true)).toBe(false);
    expect(ownerMode.ownerFrame(true, "off", true)).toBe(false);
  });

  it("the switch never names a user from the body: an extra `uid`/`to`/`refresh_token` is ignored", async () => {
    park(1, B, "b@lab.test", "rt-b");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
    const res = await SWITCH(post(SWITCH_URL, { ...at(1), uid: X, to: "https://evil.example", refresh_token: "rt-attacker" }));
    expect(await res.json()).toMatchObject({ to: HOME });
    expect(h.refreshCalls).toEqual(["rt-b", "rt-active-SECRET"]);
  });

  it("Add account clears the PKCE verifier too, so the next sign-in cannot finish the previous account's code flow", async () => {
    h.jar.set("sb-lab-auth-token-code-verifier", { name: "sb-lab-auth-token-code-verifier", value: "verifier-of-a" });
    expect((await ADD(post(ADD_URL, {}))).status).toBe(200);
    expect(h.jar.has("sb-lab-auth-token-code-verifier")).toBe(false);
    expect(h.jar.has("sb-lab-auth-token")).toBe(false);
  });
});

describe("REFUSED: AAL", () => {
  it("an aal1 session of an account with a factor lands on ITS code page; without factors in the answer, Home still meets the middleware", async () => {
    park(1, B, "b@lab.test", "rt-b");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test", factors: [{ status: "verified", factor_type: "totp" }] }, aal: "aal1" });
    expect(await (await SWITCH(post(SWITCH_URL, at(1)))).json()).toMatchObject({ to: `/login/verify?next=${encodeURIComponent(HOME)}` });
    expect(paths.gateDecision(HOME, true)).not.toBe("pass");
  });

  it("the gate 'pass' covers exactly the device-accounts routes, also after URL dot-segment normalisation", () => {
    for (const raw of ["/api/account/accounts/%2e%2e/%2e%2e/owner", "/api/account/accounts/../owner-mode", "/api/account/accounts/.%2E/x"]) {
      const p = new URL(raw, ORIGIN).pathname;
      expect(paths.isDeviceAccountsPath(p), `${raw} -> ${p}`).toBe(false);
    }
    for (const p of ["/api/account/accounts-evil", "/api/account/accountsX/switch", "/API/account/accounts"]) {
      expect(paths.isDeviceAccountsPath(p), p).toBe(false);
    }
  });

  it("switching never raises a session's level: aal comes from the refreshed token, not the cookie", async () => {
    park(1, B, "b@lab.test", "rt-b", { aal: "aal2" });
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test", factors: [{ status: "verified", factor_type: "totp" }] }, aal: "aal1" });
    expect((await (await SWITCH(post(SWITCH_URL, at(1)))).json()).to).toMatch(/^\/login\/verify\?/);
  });
});

describe("REFUSED: the account limit", () => {
  it("a 4th account is refused, also via 'replace' on a live row, a string slot, or a planted third slot", async () => {
    park(1, B, "b@lab.test", "rt-b");
    park(2, C, "c@lab.test", "rt-c");
    rawCookie("ns_acct_3", { v: 1, uid: X, email: null, name: null, rt: "rt-x", iat: 1, n: nonceOf(1) });
    expect((await ADD(post(ADD_URL, {}))).status).toBe(409);
    expect((await ADD(post(ADD_URL, { replace: 1, nonce: nonceOf(1) }))).status).toBe(409);
    expect((await ADD(post(ADD_URL, { replace: "2", nonce: nonceOf(2) }))).status).toBe(400);
    expect(slotOf(1)).toMatchObject({ uid: B });
    expect(slotOf(2)).toMatchObject({ uid: C });
    expect(h.jar.has("sb-lab-auth-token")).toBe(true);
  });
});

describe("REFUSED: logout scope", () => {
  it("logging out one parked account touches neither the active cookie nor the other slot", async () => {
    park(1, B, "b@lab.test", "rt-b");
    park(2, C, "c@lab.test", "rt-c");
    h.refresh.set("rt-b", { user: { id: B, email: "b@lab.test" } });
    await LOGOUT(post(LOGOUT_URL, at(1)));
    expect(h.jar.get("sb-lab-auth-token")?.value).toBe("active-session");
    expect(slotOf(2)).toMatchObject({ uid: C, rt: "rt-c" });
    expect(h.refreshCalls).toEqual(["rt-b"]);
  });
});
