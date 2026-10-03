#!/usr/bin/env node
/**
 * A stand-in Supabase for looking at the SIGNED-IN customer shell in a
 * browser without a database: it answers the handful of auth and PostgREST
 * calls the app layout makes with fixed, made-up rows (one organization, one
 * channel, a credit balance), and an empty list for everything else.
 *
 * Screenshots only. Binds to 127.0.0.1, holds no secret (the "anon key" the
 * app is built with is the literal string below, not a key), spends nothing,
 * writes nothing. Every write (POST/PATCH/DELETE other than the read-only
 * RPCs listed) is refused with 403, so a page cannot be tricked into
 * believing an action worked.
 *
 *   node tools/visual-qa/fake-supabase.mjs            # :54399
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399 \
 *     NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key npx next build && npx next start -p 3417
 *   node tools/visual-qa/visual-qa.mjs --base http://localhost:3417 --fake-session --pages /night-owl/home
 *
 * (NEXT_PUBLIC_* are inlined at build time: rebuild without them afterwards.)
 */
import http from "node:http";

export const FAKE_URL_DEFAULT = "http://127.0.0.1:54399";
export const FAKE_ANON = "visual-qa-not-a-key";

const USER = {
  id: "00000000-0000-4000-8000-0000000000aa",
  aud: "authenticated",
  role: "authenticated",
  email: "qa@example.com",
  app_metadata: { provider: "email" },
  user_metadata: {},
  created_at: "2026-01-01T00:00:00Z",
};

const ORG = { id: "00000000-0000-4000-8000-0000000000b1", name: "QA Studio", slug: "qa-studio", role: "owner", is_default: false };
const CHANNEL = {
  channel_id: "night-owl",
  name: "Night Owl",
  org_id: ORG.id,
  status: "active",
  youtube_channel_id: "UC_visual_qa_fake",
};

function b64url(s) {
  return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The @supabase/ssr session cookie for a fake signed-in session against `url`. */
export function sessionCookie(url = FAKE_URL_DEFAULT) {
  const host = new URL(url).hostname.split(".")[0];
  const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
  const jwt = [b64url(JSON.stringify({ alg: "none", typ: "JWT" })), b64url(JSON.stringify({ sub: USER.id, exp, role: "authenticated", aud: "authenticated" })), "unsigned"].join(".");
  const session = { access_token: jwt, token_type: "bearer", expires_in: 86400, expires_at: exp, refresh_token: "visual-qa", user: USER };
  return { name: `sb-${host}-auth-token`, value: "base64-" + b64url(JSON.stringify(session)) };
}

const RPC = {
  my_organizations: [ORG],
  is_platform_admin: false,
  billing_summary: { plan_id: "creator", plan_name: "Creator" },
  // Invite friends (0092): a made-up link with three of five friends joined.
  my_friend_invite: {
    enabled: true,
    required: 5,
    reward: 100,
    link: { token: "0123456789abcdef0123456789abcdef", created_at: "2026-10-01T00:00:00Z", org_id: ORG.id },
    joined: 3,
    paid: false,
    credits_paid: null,
    pending: false,
  },
};

const TABLES = {
  channels: [CHANNEL],
  credit_accounts: [{ org_id: ORG.id, balance: 1240, reserved: 180 }],
};

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "*" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

export function startFakeSupabase(port = 54399) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") return send(res, 204);
    if (url.pathname === "/auth/v1/user") return send(res, 200, USER);
    if (url.pathname.startsWith("/auth/v1/")) return send(res, 200, {});
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_0-9]+)/);
    if (rpc) {
      if (rpc[1] in RPC) return send(res, 200, RPC[rpc[1]]);
      return send(res, 403, { code: "42501", message: "visual-qa fake: not available" });
    }
    const table = url.pathname.match(/^\/rest\/v1\/([a-z_0-9]+)/);
    if (table && req.method === "GET") {
      const rows = TABLES[table[1]] ?? [];
      const single = String(req.headers.accept || "").includes("vnd.pgrst.object");
      if (single) return rows.length ? send(res, 200, rows[0]) : send(res, 406, { code: "PGRST116", message: "0 rows" });
      return send(res, 200, rows);
    }
    return send(res, 403, { code: "42501", message: "visual-qa fake: read-only" });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = Number(process.env.PORT || 54399);
  startFakeSupabase(port).then(() => process.stdout.write(`fake supabase on http://127.0.0.1:${port}\n`));
}
