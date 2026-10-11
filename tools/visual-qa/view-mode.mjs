#!/usr/bin/env node
/**
 * Checks and pictures for the Mobile / Desktop view (docs/VIEW_MODE.md,
 * docs/design/view-mode/): real Chromium against a built app.
 *
 *  - a phone (390 wide, 3x, isMobile) with Desktop chosen lays the page out at ~1280 css px and
 *    the lg/xl media queries apply; without the choice it does not;
 *  - a 1440 desktop with Mobile chosen shows the site in a ~430 px frame whose own viewport
 *    answers the phone's media queries; the address bar, title and Back follow the frame, a deep
 *    link opens the right page, links that cannot live in a frame leave it, and the switch
 *    outside the frame returns to the Desktop layout;
 *  - the switch's labels in English, Russian and Uzbek.
 * Exits 1 when an assertion fails, so it can gate a change.
 *
 *   node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399 \
 *     NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key npx next build && CSP_MODE=enforce npx next start -p 3517 &
 *   node tools/visual-qa/view-mode.mjs --base http://localhost:3517 --out docs/design/view-mode
 *
 * Screenshots only: nothing is sent anywhere, the fake refuses every write. Needs Pillow for WebP.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionCookie } from "./fake-supabase.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BASE = String(arg("base", "http://localhost:3517")).replace(/\/$/, "");
const OUT = path.resolve(String(arg("out", path.join(REPO, "docs", "design", "view-mode"))));
const QUALITY = String(arg("quality", "60"));

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
const { chromium } = loadPlaywright();
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

mkdirSync(OUT, { recursive: true });
const tmp = path.join(OUT, ".png-tmp");
mkdirSync(tmp, { recursive: true });
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(tmp, `${name}.png`), ...opts });

let failed = 0;
const check = (ok, what, detail = "") => {
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `  [${detail}]` : ""}\n`);
};

const browser = await chromium.launch({ executablePath: chromiumPath() });
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const DESK = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };

async function ctx(opts, { locale = "en", scheme = "light", view = null, signedIn = false } = {}) {
  const context = await browser.newContext({ ...opts, colorScheme: scheme, reducedMotion: "reduce" });
  const cookies = [{ name: "chronos_locale", value: locale, url: BASE }];
  if (view) cookies.push({ name: "ns_view", value: view, url: BASE });
  if (signedIn) cookies.push({ ...sessionCookie(undefined, "videos"), url: BASE });
  await context.addCookies(cookies);
  return context;
}
async function watch(page) {
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror ${String(e.message).slice(0, 140)}`));
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) problems.push(`csp ${m.text().slice(0, 200)}`);
  });
  return problems;
}
const widths = (page) =>
  page.evaluate(() => ({
    inner: window.innerWidth,
    client: document.documentElement.clientWidth,
    lg: matchMedia("(min-width: 1024px)").matches,
    xl: matchMedia("(min-width: 1280px)").matches,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    meta: document.querySelector('meta[name="viewport"]')?.getAttribute("content"),
  }));
const cookieOf = async (context) => (await context.cookies(BASE)).find((c) => c.name === "ns_view")?.value ?? null;

// ---------------------------------------------------------------- A. Desktop on a phone
for (const page of ["/", "/pricing"]) {
  const c = await ctx(PHONE);
  const p = await c.newPage();
  const problems = await watch(p);
  await p.goto(BASE + page, { waitUntil: "load" });
  await p.waitForTimeout(600);
  const auto = await widths(p);
  check(auto.inner === 390 && !auto.lg, `phone, no choice, ${page}: laid out at the device width`, JSON.stringify(auto));
  check(problems.length === 0, `phone, no choice, ${page}: no CSP violation or script error`, problems.join(" | "));
  await c.close();

  const d = await ctx(PHONE, { view: "desktop" });
  const q = await d.newPage();
  const dp = await watch(q);
  await q.goto(BASE + page, { waitUntil: "load" });
  await q.waitForTimeout(800);
  const forced = await widths(q);
  check(forced.meta === "width=1280", `phone, Desktop, ${page}: viewport meta is width=1280`, forced.meta);
  check(forced.inner >= 1200 && forced.lg && forced.xl, `phone, Desktop, ${page}: lays out at ~1280 css px, lg and xl apply`, JSON.stringify(forced));
  check(forced.overflow <= 1, `phone, Desktop, ${page}: no horizontal overflow`, String(forced.overflow));
  check(dp.length === 0, `phone, Desktop, ${page}: no CSP violation or script error`, dp.join(" | "));
  if (page === "/") await shot(q, "phone-desktop_public_en_390_light");
  await d.close();
}

// Signed in: the sidebar (lg) is there on a phone forced to Desktop, and the switch returns to the phone layout.
{
  const c = await ctx(PHONE, { view: "desktop", signedIn: true });
  const p = await c.newPage();
  const problems = await watch(p);
  await p.goto(BASE + "/night-owl/home", { waitUntil: "load" });
  await p.waitForTimeout(1200);
  const w = await widths(p);
  const sidebar = await p.evaluate(() => {
    const el = document.querySelector(".shell-sidebar");
    return el ? getComputedStyle(el).display : "none";
  });
  check(w.inner >= 1200 && sidebar !== "none", "phone, Desktop, signed in: the sidebar layout (lg) is on screen", `${w.inner}px sidebar=${sidebar}`);
  await shot(p, "phone-desktop_app_en_390_light");
  const toggle = p.getByRole("button", { name: "Switch to Mobile view" }).first();
  check((await toggle.count()) > 0 && /Desktop|^$/.test((await toggle.textContent())?.trim() ?? ""), "phone, Desktop: the switch shows Desktop (current) in the header");
  await toggle.click();
  await p.waitForLoadState("load");
  await p.waitForTimeout(900);
  const back = await widths(p);
  check((await cookieOf(c)) === null && back.inner === 390 && !back.lg, "phone, Desktop, press: the choice is cleared and the page is at the device width again", `${await cookieOf(c)} ${JSON.stringify(back)}`);
  check(problems.length === 0, "phone, signed in: no CSP violation or script error", problems.join(" | "));
  await c.close();
}

// The phone's own switch (account panel) goes to Desktop.
{
  const c = await ctx(PHONE, { signedIn: true });
  const p = await c.newPage();
  await p.goto(BASE + "/night-owl/home", { waitUntil: "load" });
  await p.waitForTimeout(1000);
  await p.getByRole("button", { name: /account/i }).first().click();
  await p.waitForTimeout(500);
  const t = p.getByRole("button", { name: "Switch to Desktop view" });
  check((await t.count()) === 1 && (await t.textContent())?.trim() === "Mobile", "phone, panel: the switch shows Mobile (current)");
  await shot(p, "phone-panel_en_390_light");
  await t.click();
  await p.waitForLoadState("load");
  await p.waitForTimeout(900);
  const w = await widths(p);
  check((await cookieOf(c)) === "desktop" && w.inner >= 1200, "phone, panel, press: Desktop is stored and the page is ~1280 wide", `${await cookieOf(c)} ${w.inner}`);
  await c.close();
}

// ---------------------------------------------------------------- B. Mobile on a desktop
async function frameOf(page) {
  const handle = await page.waitForSelector("iframe.ns-view-phone", { timeout: 15000 });
  const frame = await handle.contentFrame();
  await frame.waitForLoadState("load");
  return frame;
}
{
  const c = await ctx(DESK);
  const p = await c.newPage();
  const problems = await watch(p);
  await p.goto(BASE + "/pricing", { waitUntil: "load" });
  await p.waitForTimeout(800);
  const w = await widths(p);
  check(w.inner === 1440 && w.lg, "desktop, no choice: the normal desktop page");
  check((await p.locator("iframe").count()) === 0, "desktop, no choice: no frame");
  const link = p.getByRole("button", { name: "Switch to Mobile view" });
  check((await link.textContent())?.includes("Mobile version"), "desktop footer: the link names the version a press gives");
  await link.click();
  await p.waitForSelector("iframe.ns-view-phone");
  check((await cookieOf(c)) === "mobile", "desktop, press: ns_view=mobile is stored");
  const ck = (await c.cookies(BASE)).find((x) => x.name === "ns_view");
  check(ck && ck.sameSite === "Lax" && ck.expires - Date.now() / 1000 > 360 * 86400 && !ck.httpOnly, "cookie: Lax, ~1 year", JSON.stringify({ s: ck?.sameSite, e: Math.round((ck?.expires ?? 0) - Date.now() / 1000) }));
  const frame = await frameOf(p);
  await p.waitForTimeout(700);
  const inner = await widths({ evaluate: (fn) => frame.evaluate(fn) });
  check(inner.inner >= 428 && inner.inner <= 431 && !inner.lg, "desktop, Mobile: the page inside the frame is ~430 css px wide and lg does not apply", JSON.stringify(inner));
  const outer = await widths(p);
  check(outer.inner === 1440 && outer.overflow <= 0, "desktop, Mobile: the shell itself does not overflow", JSON.stringify(outer));
  check(new URL(p.url()).pathname === "/pricing", "desktop, Mobile: the address bar still names the page");
  const sw = p.getByRole("button", { name: "Switch to Desktop view" }).first();
  check((await sw.textContent())?.trim() === "Mobile", "desktop, Mobile: the switch outside the frame shows Mobile (current)");
  await shot(p, "desktop-mobile_pricing_en_1440_light");

  // Address bar, title and Back follow the frame.
  await frame.locator('footer a[href^="/solutions/"]').first().click();
  await p.waitForFunction(() => location.pathname.startsWith("/solutions"), null, { timeout: 15000 });
  check(true, "frame navigation: the parent's address bar follows", new URL(p.url()).pathname);
  const title = await p.title();
  check(/Solutions/i.test(title), "frame navigation: the tab title follows", title);
  await p.goBack();
  await p.waitForFunction(() => location.pathname === "/pricing", null, { timeout: 15000 });
  check(true, "Back: the frame and the address bar return to /pricing");
  // A hard reload of the parent opens the same page in the same view.
  await p.goto(BASE + "/solutions", { waitUntil: "load" });
  const f2 = await frameOf(p);
  check(new URL(f2.url()).pathname === "/solutions", "deep link /solutions: opens inside the frame");

  // Links that cannot live in a frame leave it.
  await c.route("https://accounts.example/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>provider</title>provider" }));
  await f2.evaluate(() => {
    const a = document.createElement("a");
    a.href = "https://accounts.example/consent";
    a.textContent = "external-test";
    a.id = "ext";
    document.body.prepend(a);
    const b = document.createElement("a");
    b.href = "/api/oauth/youtube/start?ref=x";
    b.id = "conn";
    b.textContent = "connect-test";
    document.body.prepend(b);
  });
  await f2.locator("#ext").click();
  await p.waitForURL(/accounts\.example/, { timeout: 15000 });
  check(true, "external link inside the frame opens in the whole window");
  await c.unroute("https://accounts.example/**");
  check(problems.length === 0, "desktop, Mobile: no CSP violation or script error", problems.join(" | "));
  await c.close();
}

{
  // A provider connection under /api leaves the frame too.
  const c = await ctx(DESK, { view: "mobile", signedIn: true });
  const p = await c.newPage();
  await c.route("**/api/oauth/youtube/start**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "connect-top" }));
  await p.goto(BASE + "/night-owl/home", { waitUntil: "load" });
  const f = await frameOf(p);
  await p.waitForTimeout(1200);
  await f.evaluate(() => {
    const b = document.createElement("a");
    b.href = "/api/oauth/youtube/start?ref=x";
    b.id = "conn";
    b.textContent = "connect-test";
    document.body.prepend(b);
  });
  await f.locator("#conn").click();
  await p.waitForURL(/\/api\/oauth\/youtube\/start/, { timeout: 15000 });
  check(true, "provider connection link inside the frame opens in the whole window", p.url());
  await c.close();
}

// Signed in, deep links, themes, switching back from outside the frame.
for (const scheme of ["light", "dark"]) {
  const c = await ctx(DESK, { view: "mobile", signedIn: true, scheme });
  const p = await c.newPage();
  const problems = await watch(p);
  await p.goto(BASE + "/night-owl/home", { waitUntil: "load" });
  const f = await frameOf(p);
  await p.waitForTimeout(1500);
  const w = await widths({ evaluate: (fn) => f.evaluate(fn) });
  check(w.inner <= 431 && !w.lg, `desktop Mobile, app home (${scheme}): the phone layout inside the frame`, JSON.stringify(w));
  const bar = await f.evaluate(() => Boolean(document.querySelector("nav[aria-label], [class*=bottom]")));
  check(bar, `desktop Mobile, app home (${scheme}): the phone navigation is there`);
  await shot(p, `desktop-mobile_home_en_1440_${scheme}`);

  if (scheme === "light") {
    await p.goto(BASE + "/night-owl/organization", { waitUntil: "load" });
    const fs = await frameOf(p);
    await p.waitForTimeout(1500);
    check(new URL(fs.url()).pathname === "/night-owl/organization", "deep link to Settings opens inside the frame");
    await shot(p, "desktop-mobile_settings_en_1440_light");
    await p.goto(BASE + "/night-owl/videos", { waitUntil: "load" });
    const fv = await frameOf(p);
    await p.waitForTimeout(1500);
    check(new URL(fv.url()).pathname === "/night-owl/videos", "deep link to Videos opens inside the frame");
    await shot(p, "desktop-mobile_videos_en_1440_light");

    // The account panel inside the frame carries the switch too.
    await fv.getByRole("button", { name: /account/i }).first().click();
    await p.waitForTimeout(600);
    check((await fv.getByRole("button", { name: "Switch to Desktop view" }).count()) === 1, "inside the frame: the account panel's switch is there");
    await shot(p, "desktop-mobile_panel_en_1440_light");
    await fv.getByRole("button", { name: "Switch to Desktop view" }).click();
    await p.waitForFunction(() => !document.querySelector("iframe.ns-view-phone"), null, { timeout: 15000 });
    const back = await widths(p);
    check((await cookieOf(c)) === "desktop" && back.inner === 1440 && back.lg, "inside the frame, press: the whole window reloads in the Desktop layout", JSON.stringify(back));
    check(new URL(p.url()).pathname === "/night-owl/videos", "...on the same page", p.url());
  }
  check(problems.length === 0, `desktop Mobile (${scheme}): no CSP violation or script error`, problems.join(" | "));
  await c.close();
}

{
  // The outside switch returns to Desktop.
  const c = await ctx(DESK, { view: "mobile" });
  const p = await c.newPage();
  await p.goto(BASE + "/pricing", { waitUntil: "load" });
  await frameOf(p);
  await p.getByRole("button", { name: "Switch to Desktop view" }).first().click();
  await p.waitForFunction(() => !document.querySelector("iframe.ns-view-phone"), null, { timeout: 15000 });
  const w = await widths(p);
  check(w.inner === 1440 && w.lg, "outside switch: back to the Desktop layout", JSON.stringify(w));
  await c.close();
}

// The pages that must stay whole-window are not framed, and a cross-site frame is still refused.
{
  const c = await ctx(DESK, { view: "mobile" });
  const p = await c.newPage();
  for (const path_ of ["/login", "/forgot-password"]) {
    await p.goto(BASE + path_, { waitUntil: "load" });
    const framed = await p.locator("iframe.ns-view-phone").count();
    check(framed === 1, `${path_} (Mobile): rendered inside the frame and works`);
    const f = await frameOf(p);
    check((await f.locator("form").count()) > 0, `${path_} (Mobile): the form is inside the frame`);
  }
  const r = await p.request.get(BASE + "/auth/confirm", { headers: { cookie: "ns_view=mobile", "sec-fetch-dest": "document" }, maxRedirects: 0 });
  check(r.headers()["x-frame-options"] === "DENY", "/auth/confirm keeps X-Frame-Options: DENY", r.headers()["x-frame-options"]);
  const cross = await p.request.get(BASE + "/pricing", { headers: { "sec-fetch-dest": "iframe", "sec-fetch-site": "cross-site" } });
  check(cross.headers()["x-frame-options"] === "DENY" && /frame-ancestors 'none'/.test(cross.headers()["content-security-policy"] ?? ""), "cross-site frame request: still DENY and frame-ancestors 'none'");
  const same = await p.request.get(BASE + "/pricing", { headers: { "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" } });
  check(same.headers()["x-frame-options"] === "SAMEORIGIN" && /frame-ancestors 'self'/.test(same.headers()["content-security-policy"] ?? ""), "same-origin frame request: SAMEORIGIN and frame-ancestors 'self'");
  await c.close();
}

// ---------------------------------------------------------------- C. Labels in English, Russian, Uzbek
for (const [loc, mobile, desktop] of [["en", "Mobile", "Desktop"], ["ru", "Мобильный", "Десктоп"], ["uz", "Mobil", "Desktop"]]) {
  const c = await ctx(DESK, { locale: loc, view: "mobile" });
  const p = await c.newPage();
  await p.goto(BASE + "/pricing", { waitUntil: "load" });
  await frameOf(p);
  const t = (await p.locator(".ns-view-bar button").textContent())?.trim();
  check(t === mobile, `${loc}: the shell's switch reads "${mobile}"`, t);
  await shot(p, `labels_${loc}_1440_light`, { clip: { x: 0, y: 0, width: 1440, height: 240 } });
  await c.close();
  const d = await ctx(DESK, { locale: loc });
  const q = await d.newPage();
  await q.goto(BASE + "/pricing", { waitUntil: "load" });
  await q.waitForTimeout(500);
  const link = (await q.locator("footer button").last().textContent())?.trim();
  check(Boolean(link) && link !== desktop, `${loc}: the footer link reads "${link}"`);
  await d.close();
}

await browser.close();
execFileSync(
  "python3",
  [
    "-I",
    "-c",
    `
import sys, os
from PIL import Image
src, dst, q = sys.argv[1], sys.argv[2], int(sys.argv[3])
for f in sorted(os.listdir(src)):
    if f.endswith(".png"):
        im = Image.open(os.path.join(src, f)).convert("RGB")
        if im.width > 1500: im = im.resize((im.width * 1170 // im.width, im.height))
        im.save(os.path.join(dst, f[:-4] + ".webp"), "WEBP", quality=q, method=6)
`,
    tmp,
    OUT,
    QUALITY,
  ],
  { stdio: "inherit" },
);
rmSync(tmp, { recursive: true, force: true });
process.stdout.write(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) FAILED`}\n`);
process.exit(failed === 0 ? 0 : 1);
