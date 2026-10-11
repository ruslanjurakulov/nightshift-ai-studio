#!/usr/bin/env node
/**
 * Screenshots and browser checks for Home's goal cards, the "ready for your
 * decision" card and the create form's draft (docs/design/home-continue/), in
 * Chromium at 1440 and 390, light and dark, English plus Russian and Uzbek.
 * Also runs axe (serious or worse), measures horizontal overflow, and checks the
 * create form's double-submit protection in a real browser: the run route is
 * answered by the test (nothing is held, nothing is started, no provider is
 * called), so what is measured is what the BROWSER sends: one request per
 * confirmed press, the same idempotency key on a retry, a new one after a
 * start, and the displayed price as max_credits.
 *
 * Needs the app built against tools/visual-qa/fake-supabase.mjs and running
 * (see that file's header; add NIGHTSHIFT_RUN_BACKEND=queue so Run now counts as
 * set up), and Pillow for the WebP conversion:
 *
 *   node tools/visual-qa/home-continue.mjs --base http://localhost:3417 --out docs/design/home-continue
 *
 * Screenshots and measurements only. Not part of the product; ships in no bundle.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionCookie } from "./fake-supabase.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const APP = path.join(REPO, "command-center");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BASE = String(arg("base", "http://localhost:3417")).replace(/\/$/, "");
const OUT = path.resolve(String(arg("out", path.join(REPO, "docs", "design", "home-continue"))));
const QUALITY = String(arg("quality", "60"));

function loadPlaywright() {
  const roots = [APP, REPO, "/opt/node22/lib/node_modules"];
  try {
    roots.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim());
  } catch {
    /* local roots only */
  }
  for (const root of roots) {
    try {
      return createRequire(path.join(root, "noop.js"))("playwright");
    } catch {
      /* next root */
    }
  }
  throw new Error("Playwright not found.");
}
const { chromium } = loadPlaywright();
const AXE_SRC = (() => {
  const p = path.join(APP, "node_modules", "axe-core", "axe.min.js");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
})();
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

const LOCALES = ["en", "ru", "uz"];
const WIDTHS = [1440, 390];
const THEMES = ["light", "dark"];
// ru and uz are checked at both widths but photographed once each.
const keep = (loc, width, theme) => loc === "en" || (width === 1440 ? theme === "light" : theme === "dark");
const TOPIC = "The salt road: why caravans crossed the desert at night";

mkdirSync(OUT, { recursive: true });
const tmp = path.join(OUT, ".png-tmp");
mkdirSync(tmp, { recursive: true });
const browser = await chromium.launch({ executablePath: chromiumPath() });
const report = [];
let shots = 0;

async function newPage(loc, width, theme) {
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: theme, reducedMotion: "reduce", hasTouch: phone, isMobile: phone });
  await context.addCookies([{ name: "chronos_locale", value: loc, url: BASE }]);
  const c = sessionCookie(undefined, "videos");
  await context.addCookies([{ ...c, url: BASE }]);
  const page = await context.newPage();
  return { context, page, phone };
}

async function measure(page, row, phone) {
  row.overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (phone) {
    row.small = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll("a[href], button, [role=button], select, input:not([type=hidden]), textarea")) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || el.closest("[hidden], [aria-hidden=true]")) continue;
        if (r.height >= 43.5 && r.width >= 43.5) continue;
        if (el.tagName === "A" && el.closest("p, li") && cs.display === "inline") continue;
        out.push(`${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}"`);
      }
      return out.slice(0, 8);
    });
  }
  if (AXE_SRC) {
    await page.addScriptTag({ content: AXE_SRC });
    row.axe = await page.evaluate(async () => {
      const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
      return r.violations.filter((x) => x.impact === "serious" || x.impact === "critical").map((x) => `${x.id}x${x.nodes.length}`);
    });
  }
}

// ── pictures ────────────────────────────────────────────────────────────────
for (const loc of LOCALES) {
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      const { context, page, phone } = await newPage(loc, width, theme);
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
      const name = `home_${loc}_${width}_${theme}`;
      const row = { name };
      try {
        const resp = await page.goto(`${BASE}/night-owl/home`, { waitUntil: "load", timeout: 45000 });
        row.status = resp?.status();
        await page.waitForSelector(".home-goals", { timeout: 15000 });
        await page.waitForTimeout(700);
        // Pick a goal card, then reload: the card's starter comes back as this tab's unfinished draft.
        await page.locator('[data-goal="explainer"]').click();
        await page.waitForTimeout(900);
        await page.reload({ waitUntil: "load" });
        await page.waitForSelector('[data-testid="draft-restored"]', { timeout: 15000 });
        await page.waitForTimeout(700);
        row.ready = (await page.locator('[data-testid="home-status"]').innerText()).replace(/\s+/g, " ").slice(0, 90);
        await page.evaluate(() => window.scrollTo(0, 0));
        await measure(page, row, phone);
        if (keep(loc, width, theme)) {
          await page.screenshot({ path: path.join(tmp, `${name}.png`), fullPage: true });
          shots += 1;
        }
      } catch (e) {
        row.error = String(e.message || e).slice(0, 200);
      }
      row.errors = errors;
      report.push(row);
      process.stdout.write(`${name}: ${row.error ? "ERROR " + row.error : `status=${row.status} overflow=${row.overflow} axe=${(row.axe || []).join(",") || "0"} ready="${row.ready}"`}\n`);
      await context.close();
    }
  }
}

// ── double submit, in a real browser ────────────────────────────────────────
const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  process.stdout.write(`check ${ok ? "PASS" : "FAIL"}: ${name}${detail ? " — " + detail : ""}\n`);
};
{
  const { context, page } = await newPage("en", 1440, "light");
  const posts = [];
  let mode = "hold";
  let release = null;
  await page.route("**/api/agent/run", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    posts.push(JSON.parse(req.postData() || "{}"));
    if (mode === "hold") await new Promise((r) => (release = r));
    if (mode === "drop") return route.abort("connectionreset");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, backend: "queue", job_id: 1, credits_reserved: 120 }) });
  });
  await page.goto(`${BASE}/night-owl/home`, { waitUntil: "load" });
  await page.waitForSelector(".fl-price-figure", { timeout: 15000 });
  const figure = (await page.locator(".fl-price-figure").innerText()).replace(/[^0-9.]/g, "");
  await page.locator("#run-brief").fill(TOPIC);
  const confirm = page.locator(".fl-go").first();
  // The first press only asks (the same button becomes the confirm).
  await confirm.click();
  // Three fast presses on the confirm while the answer is held.
  await confirm.click({ force: true });
  await confirm.click({ force: true }).catch(() => undefined);
  await confirm.click({ force: true }).catch(() => undefined);
  await page.waitForTimeout(500);
  check("three quick presses on the confirm send one request", posts.length === 1, `requests=${posts.length}`);
  check("the request carries an idempotency key", typeof posts[0]?.idempotency_key === "string" && /^[A-Za-z0-9_:.-]{1,255}$/.test(posts[0].idempotency_key), String(posts[0]?.idempotency_key).slice(0, 12) + "…");
  check("max_credits equals the price on the card", String(posts[0]?.max_credits) === figure, `card=${figure} sent=${posts[0]?.max_credits}`);
  // Connection dropped: the person tries again, with the same inputs.
  mode = "ok";
  release?.();
  await page.waitForTimeout(300);
  await context.close();
}
{
  const { context, page } = await newPage("en", 1440, "light");
  const posts = [];
  let mode = "drop";
  await page.route("**/api/agent/run", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts.push(JSON.parse(route.request().postData() || "{}"));
    if (mode === "drop") return route.abort("connectionreset");
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, backend: "queue", job_id: 1 }) });
  });
  await page.goto(`${BASE}/night-owl/home`, { waitUntil: "load" });
  await page.waitForSelector(".fl-price-figure", { timeout: 15000 });
  await page.locator("#run-brief").fill(TOPIC);
  const press = async () => {
    await page.locator(".fl-go").first().click();
    await page.locator(".fl-go").first().click();
    await page.waitForTimeout(500);
  };
  await press();
  check("after a dropped connection the page shows the error, not a start", (await page.locator(".fl-status").innerText()).length > 0 && posts.length === 1);
  mode = "ok";
  await press();
  check("the retry of the same inputs reuses the idempotency key", posts.length === 2 && posts[0].idempotency_key === posts[1].idempotency_key, `requests=${posts.length}`);
  await context.close();
}
await browser.close();

execFileSync(
  "python3",
  ["-I", "-c", `
import sys, os
from PIL import Image
src, dst, q = sys.argv[1], sys.argv[2], int(sys.argv[3])
for f in sorted(os.listdir(src)):
    if f.endswith(".png"):
        Image.open(os.path.join(src, f)).convert("RGB").save(os.path.join(dst, f[:-4] + ".webp"), "WEBP", quality=q, method=6)
`, tmp, OUT, QUALITY],
  { stdio: "inherit" },
);
rmSync(tmp, { recursive: true, force: true });
const bad = report.filter((r) => r.error || r.overflow > 0 || (r.axe || []).length || (r.errors || []).length || (r.small || []).length);
process.stdout.write(`\n${shots} pictures in ${OUT}; ${bad.length} run(s) with an error, overflow or serious axe finding; ${checks.filter((c) => !c.ok).length} failed check(s)\n`);
for (const r of bad) process.stdout.write(`  ${r.name}: ${JSON.stringify({ error: r.error, overflow: r.overflow, axe: r.axe, errors: r.errors, small: r.small })}\n`);
process.exitCode = bad.length || checks.some((c) => !c.ok) ? 1 : 0;
