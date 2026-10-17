import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { rejectCrossOrigin, requireSameOrigin } from "../lib/server/same-origin";

/**
 * CSRF layer for every cookie-authenticated, state-changing route (ledger BR-S-018, red-team finding S-10).
 *
 * `SameSite=Lax` alone keeps a cross-site POST from carrying the session cookie, but it is one layer. Every route
 * handler for POST, PUT, PATCH or DELETE under app/ must either
 *   (a) be wrapped in `requireSameOrigin(...)` (or call `guardAdminPost` / `isSameOriginPost` /
 *       `rejectCrossOrigin`, which is the same check), or
 *   (b) be named in MACHINE_TO_MACHINE below with the reason it authenticates by its own token or signature and so is
 *       called WITHOUT our origin (a webhook, the public API, MCP, OAuth endpoints, one-click unsubscribe).
 * A new mutating route that is neither fails here, in review, not in production. The second half calls every wrapped
 * handler with a missing, foreign, `null` and cross-site origin and expects the 403 before anything else runs.
 */

vi.mock("server-only", () => ({}));

const APP = join(__dirname, "..", "app");

/** Mutating routes that are deliberately NOT same-origin gated, each with its reason. */
const MACHINE_TO_MACHINE: Record<string, string> = {
  "api/v1/[...rest]/route.ts": "public API: bearer key (api_auth), called by customers' servers and scripts",
  "api/v1/creative/jobs/route.ts": "public API: bearer key",
  "api/v1/creative/quote/route.ts": "public API: bearer key",
  "api/v1/videos/[id]/downloads/route.ts": "public API: bearer key",
  "api/v1/videos/[id]/publish/route.ts": "public API: bearer key",
  "api/v1/videos/route.ts": "public API: bearer key",
  "api/mcp/route.ts": "MCP endpoint: OAuth bearer token, called by AI apps",
  "oauth/token/route.ts": "OAuth token endpoint: called server-to-server by the client with a code or refresh token",
  "oauth/register/route.ts": "OAuth dynamic client registration: public by RFC 7591, called by AI apps",
  "oauth/revoke/route.ts": "OAuth revocation (RFC 7009): called server-to-server with the token itself",
  "oauth/decision/route.ts": "OAuth consent: has its own, stronger check (Origin + Sec-Fetch-Site + JSON + single-use secret)",
  "api/email/unsubscribe/route.ts": "one-click unsubscribe (RFC 8058): a mail program posts it with no Origin; the 64-hex token is the authority and it can only switch mail off",
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}

const MUTATING = /export (?:(?:async )?function|const) (POST|PUT|PATCH|DELETE)\b/g;
/** Any of these in the file is the same-origin check (the helper, or the guards that call it). */
const SAME_ORIGIN_CHECKS = ["requireSameOrigin(", "guardAdminPost(", "isSameOriginPost(", "rejectCrossOrigin("];

const files = routeFiles(APP).map((p) => {
  const src = readFileSync(p, "utf8");
  const methods = [...src.matchAll(MUTATING)].map((m) => m[1]);
  return { abs: p, rel: relative(APP, p).split("\\").join("/"), src, methods };
});
const mutating = files.filter((f) => f.methods.length > 0);

describe("every mutating route has the same-origin check or a stated reason not to", () => {
  it("finds the routes (the scan is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(mutating.length).toBeGreaterThan(65);
  });

  for (const f of mutating) {
    it(`${f.rel} (${f.methods.join(", ")})`, () => {
      if (MACHINE_TO_MACHINE[f.rel]) return;
      const hit = SAME_ORIGIN_CHECKS.find((c) => f.src.includes(c));
      expect(hit, `${f.rel} exports ${f.methods.join("/")} with no same-origin check; wrap it in requireSameOrigin(), or add it to MACHINE_TO_MACHINE with the reason`).toBeTruthy();
    });
  }

  it("a wrapped file wraps EVERY one of its mutating handlers", () => {
    const bad: string[] = [];
    for (const f of mutating) {
      if (MACHINE_TO_MACHINE[f.rel] || !f.src.includes("requireSameOrigin(")) continue;
      for (const method of f.methods) {
        if (!new RegExp(`export const ${method} = requireSameOrigin\\(`).test(f.src)) bad.push(`${f.rel} ${method}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("names no machine-to-machine route that no longer exists, or that is not mutating", () => {
    const have = new Map(mutating.map((f) => [f.rel, f]));
    for (const rel of Object.keys(MACHINE_TO_MACHINE)) expect(have.has(rel), rel).toBe(true);
  });

  it("the machine-to-machine routes really authenticate by themselves (a bearer, a token or a signature)", () => {
    // Not proof, a tripwire: if one of these stops mentioning how it authenticates it should be reviewed.
    const AUTH_HINTS = ["notFound", "runApi(", "apiCaller(", "oauthDeps(", "revokeEndpoint", "tokenEndpoint", "registerEndpoint", "decision", "isUnsubscribeToken", "Origin", "origin"];
    for (const rel of Object.keys(MACHINE_TO_MACHINE)) {
      const src = mutating.find((f) => f.rel === rel)!.src;
      expect(AUTH_HINTS.some((h) => src.includes(h)), rel).toBe(true);
    }
  });
});

describe("requireSameOrigin / rejectCrossOrigin", () => {
  const OURS = "https://app.test";
  const post = (headers: Record<string, string>, url = `${OURS}/api/x`) => new Request(url, { method: "POST", headers, body: "{}" });

  it.each<[string, Record<string, string>]>([
    ["no Origin at all", {}],
    ["a foreign Origin", { origin: "https://evil.example" }],
    ["Origin: null (sandboxed iframe, data: URL, redirect)", { origin: "null" }],
    ["a sibling subdomain", { origin: "https://evil.app.test" }],
    ["the same host on http", { origin: "http://app.test" }],
    ["our Origin but Sec-Fetch-Site: cross-site", { origin: OURS, "sec-fetch-site": "cross-site" }],
    ["our Origin but Sec-Fetch-Site: same-site", { origin: OURS, "sec-fetch-site": "same-site" }],
  ])("403 for %s, and the handler never runs", async (_label, headers) => {
    const handler = vi.fn(async (_r: Request) => new Response("ran"));
    const res = await requireSameOrigin(handler)(post(headers));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(handler).not.toHaveBeenCalled();
    expect(rejectCrossOrigin(post(headers))?.status).toBe(403);
  });

  it("our own page passes, with and without Sec-Fetch-Site, and the handler gets its arguments untouched", async () => {
    const handler = vi.fn(async (_r: Request, ctx: { params: Promise<{ id: string }> }) => Response.json({ id: (await ctx.params).id }));
    const wrapped = requireSameOrigin(handler);
    for (const headers of [{ origin: OURS }, { origin: OURS, "sec-fetch-site": "same-origin" }] as Record<string, string>[]) {
      const res = await wrapped(post(headers), { params: Promise.resolve({ id: "42" }) });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "42" });
    }
    expect(rejectCrossOrigin(post({ origin: OURS }))).toBeNull();
  });

  describe("allowMissingOriginWhenSameOrigin (the XHR upload PUT only)", () => {
    const put = (headers: Record<string, string>) => new Request(`${OURS}/api/media/uploads/t`, { method: "PUT", headers, body: "x" });
    const lenient = { allowMissingOriginWhenSameOrigin: true };

    it("accepts: no Origin, but the browser says Sec-Fetch-Site: same-origin", () => {
      expect(rejectCrossOrigin(put({ "sec-fetch-site": "same-origin" }), lenient)).toBeNull();
    });
    it.each<[string, Record<string, string>]>([
      ["no Origin and no Sec-Fetch-Site", {}],
      ["no Origin and Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site" }],
      ["no Origin and Sec-Fetch-Site: same-site", { "sec-fetch-site": "same-site" }],
      ["no Origin and Sec-Fetch-Site: none", { "sec-fetch-site": "none" }],
      ["Origin: null even with same-origin", { origin: "null", "sec-fetch-site": "same-origin" }],
      ["a foreign Origin even with same-origin", { origin: "https://evil.example", "sec-fetch-site": "same-origin" }],
      ["a foreign Origin alone", { origin: "https://evil.example" }],
    ])("still refuses %s", (_label, headers) => {
      expect(rejectCrossOrigin(put(headers), lenient)?.status).toBe(403);
    });
    it("our own Origin still passes, and the strict default still refuses a missing Origin with same-origin", () => {
      expect(rejectCrossOrigin(put({ origin: OURS }), lenient)).toBeNull();
      expect(rejectCrossOrigin(put({ "sec-fetch-site": "same-origin" }))?.status).toBe(403);
    });
    it("only the media upload PUT asks for it", () => {
      const users = mutating.filter((f) => f.src.includes("allowMissingOriginWhenSameOrigin")).map((f) => f.rel);
      expect(users).toEqual(["api/media/uploads/[ticket]/route.ts"]);
    });
  });

  it("behind the reverse proxy the configured APP_ORIGIN is ours too (the request URL there is the bind address)", async () => {
    vi.stubEnv("APP_ORIGIN", "https://nightshift.example");
    try {
      const behindProxy = (origin: string) => post({ origin }, "https://0.0.0.0:3000/api/x");
      expect(rejectCrossOrigin(behindProxy("https://nightshift.example"))).toBeNull();
      expect(rejectCrossOrigin(behindProxy("https://evil.example"))?.status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("every wrapped handler refuses a missing, foreign, null or cross-site Origin with a 403", () => {
  const wrapped = mutating.filter((f) => !MACHINE_TO_MACHINE[f.rel] && f.src.includes("requireSameOrigin("));

  it("covers most of the mutating routes", () => {
    expect(wrapped.length).toBeGreaterThan(50);
  });

  for (const f of wrapped) {
    it(`${f.rel}`, async () => {
      const mod = (await import(/* @vite-ignore */ f.abs)) as Record<string, unknown>;
      for (const method of f.methods) {
        const handler = mod[method] as (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>;
        expect(typeof handler, `${f.rel} ${method}`).toBe("function");
        const url = `https://app.test/${f.rel.replace(/\/route\.ts$/, "").replace(/\[\.{0,3}(\w+)\]/g, "x")}`;
        for (const headers of [{}, { origin: "https://evil.example" }, { origin: "null" }, { origin: "https://app.test", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
          const res = await handler(new Request(url, { method, headers, body: method === "DELETE" ? undefined : "{}" }), {
            params: Promise.resolve({ id: "1", ticket: "1", comment: "1", draft: "1", post: "1", scene: "1" }),
          });
          expect(res.status, `${f.rel} ${method} ${JSON.stringify(headers)}`).toBe(403);
        }
      }
    }, 30_000);
  }
});
