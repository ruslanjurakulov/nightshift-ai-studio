#!/usr/bin/env node
/**
 * CSP smoke (BR-S-008, docs/security/CSP.md): real Chromium against a built app started with an ENFORCING policy
 * (CSP_MODE=enforce or both). Every page must load with zero violations of the enforced policy; with --fake-session
 * the signed-in customer pages the fake Supabase can render are visited too, and with --paddle the pricing page
 * loads Paddle.js and opens an overlay checkout. A positive control (an injected inline handler and an un-nonced
 * script) must be BLOCKED, or the run fails: a detector that sees nothing proves nothing.
 * Violations of the report-only half of `both` (the stricter img-src/media-src) are listed, not failed: they are the
 * measurement that mode exists for. Exits 1 when an assertion fails.
 *
 *   node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399 \
 *     NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key npx next build && CSP_MODE=enforce npx next start -p 3611 &
 *   node tools/visual-qa/csp-smoke.mjs --base http://127.0.0.1:3611 [--fake-session] [--paddle]
 *
 * (For --paddle, build with NEXT_PUBLIC_PADDLE_CLIENT_TOKEN and one NEXT_PUBLIC_PADDLE_PRICE_* set, in the
 * environment you want to check: Paddle Retain loads only in production.) Read-only: GET navigations and page
 * scripts; the fake refuses every write. Nothing is sent anywhere but the local app, its fake and Paddle's CDN.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionCookie, FAKE_URL_DEFAULT } from "./fake-supabase.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const has = (name) => process.argv.includes(`--${name}`);
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BASE = String(arg("base", "http://127.0.0.1:3611")).replace(/\/$/, "");

function loadPlaywright() {
  const roots = [path.join(REPO, "command-center"), REPO];
  try {
    roots.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim());
  } catch {
    /* local roots only */
  }
  for (const root of roots) {
    try {
      return createRequire(path.join(root, "noop.js"))("playwright");
    } catch {
      /* next */
    }
  }
  throw new Error("Playwright not found");
}
function chromiumPath() {
  for (const p of [process.env.VISUAL_QA_CHROMIUM, "/opt/pw-browsers/chromium"]) {
    try {
      if (p && statSync(p).isFile()) {
        accessSync(p, constants.X_OK);
        return p;
      }
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** Every public page (lib/public-paths.ts SITEMAP_PATHS and the sign-in pages) and the 404. */
export const PUBLIC_PAGES = [
  "/", "/studio", "/pricing", "/solutions", "/solutions/youtube-channels", "/solutions/creative-studio",
  "/solutions/developers", "/docs/api", "/mcp", "/privacy", "/terms", "/refund", "/roadmap", "/login", "/signup",
  "/forgot-password", "/reset-password", "/no-such-page",
];
/** The customer pages the fake Supabase renders for a signed-in member (tools/visual-qa/fake-supabase.mjs). */
export const SIGNED_IN_PAGES = [
  "/night-owl/home", "/night-owl/create", "/night-owl/studio", "/night-owl/videos", "/night-owl/inbox",
  "/night-owl/styles", "/night-owl/presets", "/night-owl/library", "/night-owl/editor", "/night-owl/workflows",
  "/night-owl/channels", "/night-owl/models", "/night-owl/credits", "/night-owl/usage", "/night-owl/series",
  "/night-owl/organization", "/night-owl/developers", "/night-owl/command-center", "/welcome",
  "/night-owl/editor/00000000-0000-4000-8000-000000000123",
];

const { chromium } = loadPlaywright();
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } : undefined,
});

let failed = 0;
const check = (ok, what, detail = "") => {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `  [${detail}]` : ""}\n`);
};

async function visit(ctx, url, extra) {
  const page = await ctx.newPage();
  const seen = [];
  await page.exposeFunction("__cspSmoke", (v) => seen.push(v));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      // @ts-expect-error injected by exposeFunction
      window.__cspSmoke({ directive: e.effectiveDirective, blocked: e.blockedURI, disposition: e.disposition, source: e.sourceFile });
    });
  });
  const res = await page.goto(BASE + url, { waitUntil: "load", timeout: 45_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 700) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  const extraResult = extra ? await extra(page) : undefined;
  await page.waitForTimeout(1_000);
  const enforced = res ? (await res.allHeaders())["content-security-policy"] ?? "" : "";
  await page.close();
  return { url, status: res?.status() ?? 0, enforced, seen, extraResult };
}

function judge(r) {
  check(r.enforced.includes("'strict-dynamic'"), `${r.url} carries the enforcing policy`, `HTTP ${r.status}`);
  const enforcedViolations = r.seen.filter((v) => v.disposition === "enforce");
  check(enforcedViolations.length === 0, `${r.url} has no violation of the enforced policy`, JSON.stringify(enforcedViolations).slice(0, 400));
  for (const v of r.seen.filter((x) => x.disposition === "report")) {
    process.stdout.write(`     report-only: ${r.url} ${v.directive} ${v.blocked}\n`);
  }
}

const pub = await browser.newContext();
for (const url of PUBLIC_PAGES) judge(await visit(pub, url));

if (has("fake-session")) {
  const cookie = sessionCookie(arg("fake-url", FAKE_URL_DEFAULT), "videos");
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: new URL(BASE).hostname, path: "/" }]);
  for (const url of SIGNED_IN_PAGES) judge(await visit(ctx, url));
}

if (has("paddle")) {
  const r = await visit(pub, "/pricing", async (page) => {
    const loaded = await page.waitForFunction(() => !!window.Paddle, null, { timeout: 20_000 }).then(() => true, () => false);
    await page.evaluate(() => {
      try {
        window.Paddle?.Checkout?.open({ items: [{ priceId: "pri_01cspsmoke000000000000000", quantity: 1 }] });
      } catch {
        /* a refused checkout still frames Paddle's page */
      }
    });
    await page.waitForTimeout(6_000);
    return { loaded, frames: page.frames().map((f) => f.url()).filter((u) => /paddle\.com/.test(u)) };
  });
  check(r.extraResult.loaded, "Paddle.js loaded under the enforced policy");
  check(r.extraResult.frames.length > 0, "the Paddle checkout frame opened", r.extraResult.frames.map((u) => new URL(u).origin).join(" "));
  judge(r);
}

// Positive control: injected MARKUP must not run. Two parser-inserted vectors, the shape of a real HTML injection:
// an inline event handler (script-src-attr) and an inline <script> parsed inside a same-origin srcdoc frame, which
// inherits the page's policy (script-src-elem). (A <script> created by already-running script is trusted under
// 'strict-dynamic' by design, so it is not a control: it needs script execution first, which is what is prevented.)
const control = await visit(pub, "/terms", async (page) => {
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", '<img src="data:," onerror="window.__cspA=1" onload="window.__cspA=1">');
    document.body.insertAdjacentHTML("beforeend", '<iframe id="cspctl" srcdoc="<script>parent.__cspB=1</script>"></iframe>');
  });
  await page.waitForTimeout(1_000);
  return page.evaluate(() => ({ handler: window.__cspA === 1, srcdoc: window.__cspB === 1 }));
});
check(control.extraResult.handler === false, "positive control: an injected inline handler did not run");
check(control.extraResult.srcdoc === false, "positive control: an injected inline <script> did not run");
check(
  control.seen.some((v) => v.disposition === "enforce" && v.directive === "script-src-attr"),
  "positive control: the browser reported the blocked handler",
  JSON.stringify(control.seen).slice(0, 300),
);

await browser.close();
process.stdout.write(failed ? `\n${failed} check(s) failed\n` : "\nall checks passed\n");
process.exit(failed ? 1 : 0);
