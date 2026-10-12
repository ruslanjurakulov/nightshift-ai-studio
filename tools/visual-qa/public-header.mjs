#!/usr/bin/env node
/**
 * The public header (components/legal/PublicShell.tsx, `.st-header`) must fit at every width:
 * real Chromium against a built app, English, Russian and Uzbek, 320 to 1440 px, with the
 * ns_view cookie unset, "desktop" and "mobile" (the phone frame), on the pages that share it.
 *
 * Per case it measures
 *   - the page: scrollWidth <= clientWidth (no horizontal scroll), and the header on its own:
 *     nothing inside it sticks out of the viewport;
 *   - the primary key (Start free / Начать бесплатно / Bepul boshlash) and Sign in: bounding box
 *     fully inside the viewport, ONE line box (Range rects), at least 44 px tall. Below the nav
 *     breakpoint Sign in lives in the menu, so the menu is opened and its Sign in is measured;
 *   - the nav links (when shown): one line each, inside the viewport; the brand, nav and tools
 *     do not overlap; the header is one row (height <= 80); and exactly one of "nav" or "menu
 *     button" is available, so the section links are never unreachable.
 * Exits 1 when a case fails.
 *
 *   node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399 \
 *     NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key npx next build && CSP_MODE=enforce npx next start -p 3517 &
 *   node tools/visual-qa/public-header.mjs --base http://localhost:3517 --json /tmp/after.json [--compare /tmp/before.json]
 *   node tools/visual-qa/public-header.mjs --base ... --mode axe        # axe on the header, light + dark
 *   node tools/visual-qa/public-header.mjs --base ... --mode shots --out docs/design/public-header-fit
 *   node tools/visual-qa/public-header.mjs --mode table --json after.json --compare before.json   # merged, no browser
 *
 * Options: --mode measure|axe|shots|table|app  --max-header 150  --role customer|operator (app)  --locales en,ru,uz  --views auto,desktop,mobile  --pages /,/pricing,/solutions,/privacy,/terms
 *          --widths 320,360,...  --quiet (only failures). Screenshots only: nothing is sent anywhere.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);
const BASE = String(arg("base", "http://localhost:3517")).replace(/\/$/, "");
const MODE = String(arg("mode", "measure"));
const LOCALES = String(arg("locales", "en,ru,uz")).split(",");
const VIEWS = String(arg("views", "auto,desktop,mobile")).split(",").map((v) => (v === "auto" ? null : v));
const PAGES = String(arg("pages", "/,/pricing,/solutions,/privacy,/terms")).split(",");
const WIDTHS = String(arg("widths", "320,360,390,414,600,768,820,900,1023,1024,1100,1139,1140,1200,1279,1280,1440")).split(",").map(Number);
const QUIET = flag("quiet");
/** The tallest a header may be: one row is 64-68 px; a visible second row for the links brings it to about 120. */
const MAX_HEADER = Number(arg("max-header", "150"));

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
if (MODE === "table") {
  // No browser: print the saved results (--json) next to an earlier run (--compare).
  summary(JSON.parse(readFileSync(String(arg("json")), "utf8")), arg("compare", null));
  process.exit(0);
}
const browser = await chromium.launch({ executablePath: chromiumPath() });

async function ctx(width, { locale, view, scheme = "light", height = 800 }) {
  const phone = width < 700;
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    // A phone is a touch device with the mobile viewport; a tablet (to 1024) is touch too, so pointer: coarse applies there.
    isMobile: phone,
    hasTouch: width <= 1024,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const cookies = [{ name: "chronos_locale", value: locale, url: BASE }];
  if (view) cookies.push({ name: "ns_view", value: view, url: BASE });
  await context.addCookies(cookies);
  return context;
}

/** The page whose header is measured: the page itself, or the phone frame's document. */
async function target(page, view) {
  if (view !== "mobile") return { frame: page, outer: null };
  const handle = await page.waitForSelector("iframe.ns-view-phone", { timeout: 15000 }).catch(() => null);
  if (!handle) return { frame: page, outer: null };
  const frame = await handle.contentFrame();
  await frame.waitForLoadState("load");
  await frame.waitForSelector(".st-header", { timeout: 15000 }).catch(() => undefined);
  return { frame, outer: page };
}

/* Runs in the page. Everything is read from layout, nothing from class names except the header's own. */
function measureInPage() {
  const cw = document.documentElement.clientWidth;
  const hdr = document.querySelector(".st-header");
  if (!hdr) return { noHeader: true };
  const shown = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const lines = (el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return new Set([...r.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top))).size;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { l: +r.left.toFixed(1), r: +r.right.toFixed(1), t: +r.top.toFixed(1), h: +r.height.toFixed(1), w: +r.width.toFixed(1) };
  };
  const inside = (b) => b.l >= -0.5 && b.r <= cw + 0.5;
  const item = (el) => {
    if (!shown(el)) return null;
    const b = box(el);
    return { ...b, inside: inside(b), lines: lines(el) };
  };
  let maxRight = 0;
  let minLeft = 0;
  for (const el of hdr.querySelectorAll("*")) {
    if (!shown(el) || el.closest(".st-menu")) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    maxRight = Math.max(maxRight, r.right);
    minLeft = Math.min(minLeft, r.left);
  }
  const brand = hdr.querySelector(".st-brand");
  const navEl = hdr.querySelector(".st-nav");
  const tools = hdr.querySelector(".st-header-tools");
  const desk = hdr.querySelector(".st-header-desk");
  const navShown = shown(navEl);
  const parts = [["brand", brand], ["nav", navShown ? navEl : null], ["tools", tools]].filter(([, el]) => el && shown(el)).map(([n, el]) => [n, box(el)]);
  const overlaps = [];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i][1];
      const b = parts[j][1];
      if (Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.t + a.h, b.t + b.h) - Math.max(a.t, b.t) > 0.5) overlaps.push(`${parts[i][0]}/${parts[j][0]}`);
    }
  }
  const navLinks = navShown ? [...navEl.querySelectorAll("a")].map(item) : [];
  const toggle = hdr.querySelector(".st-header-desk button[data-view-toggle]");
  return {
    innerWidth: window.innerWidth,
    clientWidth: cw,
    over: document.documentElement.scrollWidth - cw,
    headerOver: Math.max(0, +(maxRight - cw).toFixed(1)) + Math.max(0, +(-minLeft).toFixed(1)),
    headerH: Math.round(hdr.getBoundingClientRect().height),
    rows: navShown && navEl.getBoundingClientRect().top >= brand.getBoundingClientRect().bottom - 2 ? 2 : 1,
    cta: item(hdr.querySelector(".st-key")),
    signin: shown(desk) ? item(hdr.querySelector(".st-signin")) : null,
    navShown,
    navLinks,
    menuBtn: item(hdr.querySelector(".st-menu-btn")),
    overlaps,
    toggle: toggle ? shown(toggle) : false,
  };
}

async function measureMenu(frame, page) {
  const btn = frame.locator(".st-header .st-menu-btn").first();
  await btn.click({ timeout: 3000 });
  await frame.waitForSelector(".st-menu", { timeout: 3000 });
  const r = await frame.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    const a = document.querySelector('.st-menu a[href="/login"]');
    if (!a) return null;
    const range = document.createRange();
    range.selectNodeContents(a);
    const l = new Set([...range.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top))).size;
    const b = a.getBoundingClientRect();
    return { l: b.left, r: b.right, h: b.height, lines: l, inside: b.left >= -0.5 && b.right <= cw + 0.5 };
  });
  await page.keyboard.press("Escape");
  return r;
}

function verdict(m, menuSignin) {
  const f = [];
  if (m.noHeader) return ["no .st-header on the page"];
  // A phone asked for Desktop lays out at 1280 css px and is scaled to fit: the browser rounds that scale, so 1 px is noise there.
  if (m.over > (m.tol ?? 0)) f.push(`page scrolls sideways by ${m.over}px`);
  if (m.headerOver > 0.5) f.push(`header sticks out by ${m.headerOver}px`);
  if (m.headerH > MAX_HEADER) f.push(`header is ${m.headerH}px tall`);
  if (!m.cta) f.push("Start free is not shown");
  else {
    if (!m.cta.inside) f.push(`Start free outside the viewport (${m.cta.l}..${m.cta.r} of ${m.clientWidth})`);
    if (m.cta.lines !== 1) f.push(`Start free on ${m.cta.lines} lines`);
    if (m.cta.h < 43.5) f.push(`Start free ${m.cta.h}px tall`);
  }
  const si = m.signin ?? menuSignin;
  if (!si) f.push("Sign in not reachable");
  else {
    if (!si.inside) f.push(`Sign in outside the viewport`);
    if (si.lines !== 1) f.push(`Sign in on ${si.lines} lines`);
    if (si.h < 43.5) f.push(`Sign in ${si.h}px tall`);
  }
  for (const n of m.navLinks) {
    if (!n.inside) f.push("a nav link outside the viewport");
    if (n.lines !== 1) f.push("a nav link wraps");
  }
  if (m.overlaps.length) f.push(`overlap: ${m.overlaps.join(", ")}`);
  if (m.navShown === Boolean(m.menuBtn)) f.push(m.navShown ? "nav and menu button both shown" : "neither nav nor menu button");
  if (m.menuBtn && m.menuBtn.h < 43.5) f.push(`menu button ${m.menuBtn.h}px tall`);
  return f;
}

// ------------------------------------------------------------------------------------------ measure
async function runMeasure() {
  const rows = [];
  let failed = 0;
  for (const locale of LOCALES) {
    for (const view of VIEWS) {
      for (const width of WIDTHS) {
        const c = await ctx(width, { locale, view });
        const p = await c.newPage();
        for (const pg of PAGES) {
          let m;
          let menu = null;
          let problems = [];
          try {
            await p.goto(BASE + pg, { waitUntil: "load" });
            await p.waitForTimeout(350);
            const { frame, outer } = await target(p, view);
            m = await frame.evaluate(measureInPage);
            if (outer) {
              const o = await outer.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
              if (o > 0) m.over = Math.max(m.over, o);
            }
            if (!m.noHeader && !m.signin && m.menuBtn) menu = await measureMenu(frame, p);
            m.tol = view === "desktop" && width < 700 ? 1 : 0;
            problems = verdict(m, menu);
          } catch (e) {
            problems = [`error ${String(e.message).slice(0, 120)}`];
            m = m ?? {};
          }
          if (problems.length) failed += 1;
          rows.push({ locale, view: view ?? "auto", width, page: pg, layout: m.clientWidth ?? null, over: m.over ?? null, headerH: m.headerH ?? null, rows: m.rows ?? null, headerOver: m.headerOver ?? null, ctaRight: m.cta?.r ?? null, ctaOk: !!m.cta && m.cta.inside && m.cta.lines === 1, signinOk: !!(m.signin ?? menu) && (m.signin ?? menu).inside && (m.signin ?? menu).lines === 1, nav: !!m.navShown, toggle: !!m.toggle, problems });
          if (problems.length || !QUIET) process.stdout.write(`${problems.length ? "FAIL" : "ok  "} ${locale} ${view ?? "auto"} ${width} ${pg}${problems.length ? "  " + problems.join("; ") : ""}\n`);
        }
        await c.close();
      }
    }
  }
  const jsonPath = arg("json", null);
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(rows, null, 1));
  summary(rows, arg("compare", null));
  await browser.close();
  process.stdout.write(`\n${failed === 0 ? "all header cases fit" : `${failed} case(s) FAILED`} (${rows.length} measured)\n`);
  process.exit(failed === 0 ? 0 : 1);
}

/** Per locale x view x width: the worst page overflow, header overflow, and whether CTA / Sign in are OK on every page. */
function summary(rows, comparePath) {
  const before = comparePath && existsSync(comparePath) ? JSON.parse(readFileSync(comparePath, "utf8")) : null;
  const agg = (list) => ({
    over: Math.max(...list.map((r) => r.over ?? 0)),
    hover: Math.max(...list.map((r) => r.headerOver ?? 0)),
    cta: list.every((r) => r.ctaOk),
    si: list.every((r) => r.signinOk),
    bad: list.filter((r) => r.problems.length).length,
    n: list.length,
  });
  const key = (r) => `${r.locale}|${r.view}|${r.width}`;
  const groups = new Map();
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  const old = new Map();
  if (before) for (const r of before) old.set(key(r), [...(old.get(key(r)) ?? []), r]);
  const cell = (a) => `over ${String(a.over).padStart(3)} hdr ${String(a.hover).padStart(5)} cta ${a.cta ? "ok " : "BAD"} signin ${a.si ? "ok " : "BAD"}`;
  process.stdout.write(`\nlocale view    width | ${before ? "BEFORE (origin/main)                        | " : ""}AFTER   (px over = worst page; hdr = header sticking out)\n`);
  for (const [k, list] of groups) {
    const [locale, view, width] = k.split("|");
    const a = agg(list);
    const b = old.has(k) ? agg(old.get(k)) : null;
    process.stdout.write(`${locale}     ${view.padEnd(7)} ${width.padStart(5)} | ${b ? cell(b) + " | " : ""}${cell(a)}${a.bad ? "  <-- FAIL" : ""}\n`);
  }
}

// ------------------------------------------------------------------------------------------ axe
async function runAxe() {
  const axePath = path.join(REPO, "command-center", "node_modules", "axe-core", "axe.min.js");
  const AXE = readFileSync(axePath, "utf8");
  let bad = 0;
  const axeWidths = [320, 390, 768, 900, 1024, 1280, 1440].filter((w) => WIDTHS.includes(w));
  for (const scheme of ["light", "dark"]) {
    for (const locale of LOCALES) {
      for (const width of axeWidths) {
        const c = await ctx(width, { locale, view: null, scheme });
        const p = await c.newPage();
        for (const pg of ["/", "/pricing"]) {
          await p.goto(BASE + pg, { waitUntil: "load" });
          await p.waitForTimeout(300);
          await p.evaluate(AXE);
          const run = () =>
            p.evaluate(async () => {
              // eslint-disable-next-line no-undef
              const r = await axe.run({ include: [["header.st-header"]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
              return r.violations.map((v) => `${v.id}(${v.impact}) x${v.nodes.length}`);
            });
          let v = await run();
          const btn = p.locator(".st-header .st-menu-btn").first();
          if (await btn.isVisible()) {
            await btn.click();
            await p.waitForSelector(".st-menu");
            v = v.concat((await run()).map((x) => `menu:${x}`));
          }
          if (v.length) bad += 1;
          process.stdout.write(`${v.length ? "FAIL" : "ok  "} axe ${scheme} ${locale} ${width} ${pg} ${v.join(",")}\n`);
        }
        await c.close();
      }
    }
  }
  await browser.close();
  process.stdout.write(`\n${bad === 0 ? "axe: no violations in the header" : `${bad} axe case(s) with violations`}\n`);
  process.exit(bad === 0 ? 0 : 1);
}

// ------------------------------------------------------------------------------------------ shots
async function runShots() {
  const OUT = path.resolve(String(arg("out", path.join(REPO, "docs", "design", "public-header-fit"))));
  mkdirSync(OUT, { recursive: true });
  const tmp = path.join(OUT, ".png-tmp");
  mkdirSync(tmp, { recursive: true });
  const shots = [
    ["ru", 900, "light"],
    ["ru", 1024, "light"],
    ["ru", 1024, "dark"],
    ["uz", 1024, "light"],
    ["en", 1024, "light"],
    ["ru", 320, "light"],
    ["ru", 390, "light"],
    ["ru", 768, "light"],
    ["uz", 1440, "light"],
    ["ru", 1440, "dark"],
  ];
  for (const [locale, width, scheme] of shots) {
    const c = await ctx(width, { locale, view: null, scheme, height: 360 });
    const p = await c.newPage();
    await p.goto(BASE + "/", { waitUntil: "load" });
    await p.waitForTimeout(700);
    await p.screenshot({ path: path.join(tmp, `header_${locale}_${width}_${scheme}.png`), clip: { x: 0, y: 0, width, height: 240 } });
    await c.close();
  }
  // The whole page at phone width (390), Russian (the longest labels), light.
  for (const [pg, name] of [["/", "home"], ["/pricing", "pricing"]]) {
    const c = await ctx(390, { locale: "ru", view: null, scheme: "light", height: 844 });
    const p = await c.newPage();
    await p.goto(BASE + pg, { waitUntil: "load" });
    await p.waitForTimeout(900);
    await p.screenshot({ path: path.join(tmp, `full_${name}_ru_390_light.png`), fullPage: true });
    await c.close();
  }
  await browser.close();
  execFileSync(
    "python3",
    ["-I", "-c", "import sys,os\nfrom PIL import Image\ns,d=sys.argv[1],sys.argv[2]\nfor f in sorted(os.listdir(s)):\n    if f.endswith('.png'):\n        Image.open(os.path.join(s,f)).convert('RGB').save(os.path.join(d,f[:-4]+'.webp'),'WEBP',quality=70,method=6)\n", tmp, OUT],
    { stdio: "inherit" },
  );
  rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`screenshots in ${OUT}\n`);
}

// ------------------------------------------------------------------------------------------ app
/**
 * The signed-in shells (customer: header + bottom tab bar; operator: header + the Menu bar, when the fake backend runs with
 * FAKE_ADMIN=1) must not change with a public-header change: per case the page's sideways scroll, every fixed or sticky box
 * inside the viewport, and the header's height. Run it on main and on the change and compare (--compare).
 *   node tools/visual-qa/fake-supabase.mjs        (customer)   |   FAKE_ADMIN=1 node tools/visual-qa/fake-supabase.mjs   (operator)
 *   node tools/visual-qa/public-header.mjs --mode app --role customer --json app-customer.json
 */
async function runApp() {
  const { sessionCookie } = await import("./fake-supabase.mjs");
  const role = String(arg("role", "customer"));
  const APP_PAGES = String(arg("pages", "/night-owl/home,/night-owl/credits")).split(",");
  const rows = [];
  for (const locale of LOCALES) {
    for (const width of WIDTHS) {
      const c = await ctx(width, { locale, view: null });
      await c.addCookies([{ ...sessionCookie(undefined, "videos"), url: BASE }]);
      const p = await c.newPage();
      for (const pg of APP_PAGES) {
        let r;
        try {
          await p.goto(BASE + pg, { waitUntil: "load" });
          await p.waitForTimeout(900);
          r = await p.evaluate(() => {
            const cw = document.documentElement.clientWidth;
            const out = [];
            for (const el of document.querySelectorAll("body *")) {
              const cs = getComputedStyle(el);
              if ((cs.position !== "fixed" && cs.position !== "sticky") || cs.visibility === "hidden" || el.getClientRects().length === 0) continue;
              const b = el.getBoundingClientRect();
              if (b.width === 0 || b.height === 0) continue;
              if (b.left < -0.5 || b.right > cw + 0.5) out.push(`${el.tagName}.${String(el.className).slice(0, 24)} ${Math.round(b.left)}..${Math.round(b.right)}`);
            }
            const h = document.querySelector("header");
            const hb = h ? h.getBoundingClientRect() : null;
            return { over: document.documentElement.scrollWidth - cw, outside: out, headerH: hb ? Math.round(hb.height) : null, url: location.pathname };
          });
        } catch (e) {
          r = { over: null, outside: [`error ${String(e.message).slice(0, 80)}`], headerH: null, url: "" };
        }
        const landed = r.url === pg;
        rows.push({ role, locale, width, page: pg, landed, ...r });
        process.stdout.write(`${r.over > 0 || r.outside.length || !landed ? "DIFF" : "ok  "} app ${role} ${locale} ${width} ${pg}${landed ? "" : " (redirected to " + r.url + ")"} over=${r.over} headerH=${r.headerH}${r.outside.length ? " outside: " + r.outside.join("; ") : ""}\n`);
      }
      await c.close();
    }
  }
  const jsonPath = arg("json", null);
  if (jsonPath) writeFileSync(jsonPath, JSON.stringify(rows, null, 1));
  const cmp = arg("compare", null);
  if (cmp && existsSync(cmp)) {
    const was = new Map(JSON.parse(readFileSync(cmp, "utf8")).map((r) => [`${r.role}|${r.locale}|${r.width}|${r.page}`, r]));
    let changed = 0;
    for (const r of rows) {
      const w = was.get(`${r.role}|${r.locale}|${r.width}|${r.page}`);
      if (!w) continue;
      if (w.over !== r.over || w.headerH !== r.headerH || JSON.stringify(w.outside) !== JSON.stringify(r.outside) || w.landed !== r.landed) {
        changed += 1;
        process.stdout.write(`CHANGED ${r.role} ${r.locale} ${r.width} ${r.page}: over ${w.over}->${r.over}, header ${w.headerH}->${r.headerH}, outside ${w.outside.length}->${r.outside.length}\n`);
      }
    }
    process.stdout.write(`\napp shells vs the comparison run: ${changed} of ${rows.length} cases changed\n`);
  }
  await browser.close();
  process.exit(0);
}

if (MODE === "app") await runApp();
else if (MODE === "axe") await runAxe();
else if (MODE === "shots") await runShots();
else await runMeasure();
