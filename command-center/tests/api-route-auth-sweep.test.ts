import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Breach wave 7: a new API route cannot be added without a way to tell who is
 * asking.
 *
 * The middleware sends a signed-out visitor to /login for every path except the
 * public ones (lib/public-paths.ts), but that is one layer: it skips a few
 * exact files, it leaves /api/v1 and /api/mcp to their own key check, and it
 * lets the signed media link and the upload PUT through to a route that checks
 * for itself. So every route file here must reach one of the checks below, and
 * a route that reaches none has to be named in PUBLIC_BY_DESIGN with the reason
 * — in review, in this file, not by accident.
 *
 * It is a static scan: it proves a check is written, not that it is right.
 * The behaviour of each check is in the route's own tests and in
 * tests/security (the database refuses regardless).
 */

const API = join(__dirname, "..", "app", "api");

/** What counts as "the route asks who is calling". */
const AUTH_CALLS = [
  "getUser(",            // the signed-in session (lib/supabase/server)
  "requireOperator",     // a platform operator
  "creativeSession(",    // the creative routes' session helper
  "workflowSession(",    // the workflow routes' session helper
  "callInbox(",          // the comment inbox routes' helper (lib/server/comment-inbox): getUser, then one database function as that person
  "startSocialConnect(", // social connect: getUser + org role inside
  "finishSocialConnect(",
  "runApi(",             // the public API: a bearer key, checked by api_auth
  "apiCaller(",          // the MCP endpoint's key check
  "verifyMedia(",        // the signed media link's HMAC
];

/** Routes allowed to carry no check of their own, and why. */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  "v1/[...rest]/route.ts": "the API's own 404 for an unknown path; it answers nothing about anyone",
  "handle-available/route.ts":
    "the sign-up form's username check, asked before an account exists: same-origin POST only, one yes/no/unknown, limited per address and platform-wide in the database (0096)",
  "email/unsubscribe/route.ts":
    "the one-click unsubscribe behind every e-mail (0103): POST only, and the person is NOT signed in (a mail program posts to it); the 64-hex token in the query is the authority, matched in the database, and the only thing it can do is switch mail off",
  "pv/route.ts":
    "the public site's page count, posted by a visitor with no account: same-origin POST only, always 204, reads no cookie and no address, counts only the public marketing pages under a platform-wide ceiling in the database (0104)",
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}

describe("every API route asks who is calling", () => {
  const files = routeFiles(API).map((p) => ({ rel: relative(API, p).split("\\").join("/"), src: readFileSync(p, "utf8") }));

  it("finds the routes (the scan is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(60);
  });

  for (const { rel, src } of files) {
    it(`${rel}`, () => {
      if (PUBLIC_BY_DESIGN[rel]) return;
      const hit = AUTH_CALLS.find((c) => src.includes(c));
      expect(hit, `${rel} reaches none of: ${AUTH_CALLS.join(" ")}`).toBeTruthy();
    });
  }

  it("names no route as public that no longer exists", () => {
    const have = new Set(files.map((f) => f.rel));
    for (const rel of Object.keys(PUBLIC_BY_DESIGN)) expect(have.has(rel), rel).toBe(true);
  });

  it("every handler of a session route runs its check before it reads the body", () => {
    // A handler that parses the request body before the session check lets an
    // unauthenticated caller make the server do work (and learn parse errors).
    const bad: string[] = [];
    for (const { rel, src } of files) {
      if (rel.startsWith("v1/") || rel === "mcp/route.ts" || rel.startsWith("media/file/") || PUBLIC_BY_DESIGN[rel]) continue;
      const body = src.indexOf("request.json()");
      const auth = Math.min(...AUTH_CALLS.map((c) => src.indexOf(c)).filter((i) => i >= 0), Infinity);
      if (body >= 0 && auth > body) bad.push(rel);
    }
    expect(bad).toEqual([]);
  });
});
