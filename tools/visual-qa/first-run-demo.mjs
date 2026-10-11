#!/usr/bin/env node
/**
 * Pictures and measurements for the first-run work (docs/design/first-run-demo/):
 * the landing hero with its free-example entry, /welcome step 3 and the empty
 * Home of a new account with no channel, in Chromium. It also measures, rather
 * than assumes, what the change is for:
 *
 *   - the example entry is above the fold at 390x844 and at 1440x900,
 *   - "Start free" is still the only filled key in the hero,
 *   - the in-page jump lands the example under the sticky header (and is
 *     instant under reduced motion),
 *   - how far down the page the example sits (scroll depth, in screens),
 *   - the link from /welcome and from the empty Home opens a page with the
 *     picture desk's Generate key (so the link resolves for a no-channel account),
 *   - axe: no serious or critical findings on the landing.
 *
 * Needs the app built against tools/visual-qa/fake-supabase.mjs and running
 * (see that file's header), and Pillow for the WebP conversion:
 *
 *   PORT=54399 node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399 \
 *     NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key npx next build && npx next start -p 3461 &
 *   node tools/visual-qa/first-run-demo.mjs --base http://localhost:3461 --out docs/design/first-run-demo
 *
 * Screenshots only: nothing is sent anywhere, the fake refuses every write.
 * Not part of the product; ships in no bundle.
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
const BASE = String(arg("base", "http://localhost:3461")).replace(/\/$/, "");
const OUT = path.resolve(String(arg("out", path.join(REPO, "docs", "design", "first-run-demo"))));
const QUALITY = String(arg("quality", "58"));

function loadPlaywright() {
  const roots = [APP, REPO, "/opt/node22/lib/node_modules"];
  try {
    roots.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim());
  } catch {
    /* no npm on PATH: the local roots only */
  }
  for (const root of roots) {
    try {
      return createRequire(path.join(root, "noop.js"))("playwright");
    } catch {
      /* next root */
    }
  }
  throw new Error("Playwright not found (command-center/node_modules or the global npm root).");
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
const SIZES = [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
];

mkdirSync(OUT, { recursive: true });
const tmp = path.join(OUT, ".png-tmp");
mkdirSync(tmp, { recursive: true });
const browser = await chromium.launch({ executablePath: chromiumPath() });
const findings = [];
const note = (row) => {
  findings.push(row);
  process.stdout.write(`${JSON.stringify(row)}\n`);
};

async function context({ width, height }, theme, loc, state, reduced = true) {
  const phone = width < 600;
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: reduced ? "reduce" : "no-preference",
    hasTouch: phone,
    isMobile: phone,
  });
  await ctx.addCookies([{ name: "chronos_locale", value: loc, url: BASE }]);
  if (state) await ctx.addCookies([{ ...sessionCookie(undefined, state), url: BASE }]);
  return ctx;
}

const shot = async (page, name, opts = {}) => page.screenshot({ path: path.join(tmp, `${name}.png`), ...opts });

// ── Landing: pictures and measurements ────────────────────────────────────
for (const size of SIZES) {
  for (const loc of LOCALES) {
    for (const theme of ["light", "dark"]) {
      const ctx = await context(size, theme, loc, null);
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
      await page.goto(`${BASE}/`, { waitUntil: "load", timeout: 45000 });
      await page.waitForTimeout(900);
      const m = await page.evaluate(() => {
        const q = (s) => document.querySelector(s);
        const r = (el) => {
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) };
        };
        const hero = q(".nx-hero");
        const demo = hero.querySelector('a[href="#try"]');
        const cta = hero.querySelector(".nx-btn");
        // A "filled key" is a link or button in the hero copy (not the motion switch beside the picture) whose own background is not transparent.
        const filled = [...hero.querySelectorAll(".nx-hero-copy a, .nx-hero-copy button")].filter((el) => {
          const bg = getComputedStyle(el).backgroundColor;
          return bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
        });
        const tryTop = q("#try").getBoundingClientRect().top + window.scrollY;
        return {
          vh: window.innerHeight,
          demo: r(demo),
          demoText: demo.textContent.trim(),
          cta: r(cta),
          filledKeys: filled.map((el) => el.textContent.trim().slice(0, 30)),
          tryTopPx: Math.round(tryTop),
          pageHeight: document.documentElement.scrollHeight,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          headerH: Math.round((q("header")?.getBoundingClientRect().height ?? 0)),
        };
      });
      const row = {
        scene: "landing",
        loc,
        size: `${size.width}x${size.height}`,
        theme,
        demoAboveFold: m.demo.bottom <= m.vh,
        demoBottom: m.demo.bottom,
        ctaBottom: m.cta.bottom,
        demoH: m.demo.h,
        filledKeys: m.filledKeys,
        tryDepthScreens: Number((m.tryTopPx / m.vh).toFixed(2)),
        tryTopPx: m.tryTopPx,
        pageHeight: m.pageHeight,
        overflow: m.overflow,
        pageErrors: errors,
      };
      if (AXE_SRC) {
        await page.addScriptTag({ content: AXE_SRC });
        row.axe = await page.evaluate(async () => {
          const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
          return r.violations.filter((x) => x.impact === "serious" || x.impact === "critical").map((x) => `${x.id}x${x.nodes.length}`);
        });
      }
      note(row);
      const keep = loc === "en" || (loc === "uz" && theme === "light") || (loc === "ru" && theme === "dark");
      if (keep) await shot(page, `landing-hero_${loc}_${size.width}_${theme}`);
      await ctx.close();
    }
  }
}

// ── Landing: the jump, keyboard focus, reduced motion ─────────────────────
for (const size of SIZES) {
  for (const reduced of [true, false]) {
    const ctx = await context(size, "light", "en", null, reduced);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: "load", timeout: 45000 });
    await page.waitForTimeout(700);
    const demo = page.locator('.nx-hero a[href="#try"]');
    // Keyboard: Tab from the top until the example link has focus.
    let focused = false;
    for (let i = 0; i < 40 && !focused; i++) {
      await page.keyboard.press("Tab");
      focused = await page.evaluate(() => document.activeElement?.matches('.nx-hero a[href="#try"]') ?? false);
    }
    const ring = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return { outline: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor };
    });
    if (reduced) await shot(page, `landing-hero-focus_en_${size.width}_light`);
    await page.keyboard.press("Enter");
    // Smooth scrolling needs time; reduced motion should already be there.
    const early = await page.evaluate(() => Math.round(window.scrollY));
    await page.waitForTimeout(reduced ? 150 : 1400);
    const landed = await page.evaluate(() => {
      const t = document.querySelector("#try").getBoundingClientRect();
      const h = document.querySelector("header")?.getBoundingClientRect();
      const label = document.querySelector("#try .nx-h2")?.getBoundingClientRect();
      return { sectionTop: Math.round(t.top), headerBottom: Math.round(h?.bottom ?? 0), headingTop: Math.round(label?.top ?? 0), scrollY: Math.round(window.scrollY), hash: location.hash };
    });
    note({
      scene: "jump",
      size: `${size.width}x${size.height}`,
      reducedMotion: reduced,
      keyboardReachable: focused,
      focusRing: ring,
      scrollRightAfterEnter: early,
      ...landed,
      headingBelowHeader: landed.headingTop >= landed.headerBottom,
    });
    if (reduced && size.width === 390) await shot(page, `landing-demo-jump_en_390_light`);
    await ctx.close();
  }
}

// ── Welcome step 3 and the empty Home: a new account with no channel ──────
for (const size of SIZES) {
  for (const loc of LOCALES) {
    const theme = loc === "en" ? "light" : "dark";
    if (loc !== "en" && size.width !== 390) continue;
    const ctx = await context(size, theme, loc, "new");
    const page = await ctx.newPage();
    await page.goto(`${BASE}/welcome`, { waitUntil: "load", timeout: 45000 });
    await page.waitForTimeout(700);
    // Step "about" -> "next": the Skip key.
    const skip = page.locator(".g5-actions .btn-quiet").first();
    await skip.click();
    await page.waitForTimeout(500);
    const media = page.locator('.g5-next-step a[href$="/create?desk=image"]');
    const links = await page.locator(".g5-next-step").evaluateAll((lis) => lis.map((li) => ({ n: li.querySelector(".g5-num")?.textContent, title: li.querySelector(".g5-row-title")?.textContent, href: li.querySelector("a")?.getAttribute("href") ?? null })));
    note({ scene: "welcome-step3", loc, size: `${size.width}x${size.height}`, mediaLinks: await media.count(), rows: links });
    await shot(page, `welcome-step3_${loc}_${size.width}_${theme}`, { fullPage: true });
    // The link resolves for a no-channel account: it opens the picture desk with its price/Generate key.
    if (loc === "en" && size.width === 390) {
      const href = await media.first().getAttribute("href");
      const resp = await page.goto(BASE + href, { waitUntil: "load", timeout: 45000 });
      await page.waitForTimeout(1200);
      const desk = await page.evaluate(() => ({ url: location.pathname + location.search, h1: document.querySelector("h1")?.textContent, buttons: [...document.querySelectorAll("button")].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 12), alert: document.querySelector('[role="alert"]')?.textContent?.slice(0, 120) ?? null }));
      note({ scene: "media-link-resolves", status: resp?.status(), ...desk });
      await shot(page, `media-desk-no-channel_en_390_light`);
    }
    await ctx.close();
  }
}

for (const size of SIZES) {
  for (const loc of LOCALES) {
    const theme = loc === "en" ? "dark" : "light";
    if (loc !== "en" && size.width !== 390) continue;
    const ctx = await context(size, theme, loc, "new");
    const page = await ctx.newPage();
    await page.goto(`${BASE}/night-owl/home`, { waitUntil: "load", timeout: 45000 });
    await page.waitForTimeout(1000);
    const row = await page.evaluate(() => {
      const a = document.querySelector('[data-testid="home-try-media"]');
      const connect = [...document.querySelectorAll("a")].find((x) => x.getAttribute("href")?.endsWith("/channels/new"));
      return { media: a?.getAttribute("href") ?? null, mediaText: a?.textContent?.trim() ?? null, connect: connect?.getAttribute("href") ?? null, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    if (AXE_SRC) {
      await page.addScriptTag({ content: AXE_SRC });
      row.axe = await page.evaluate(async () => {
        const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
        return r.violations.filter((x) => x.impact === "serious" || x.impact === "critical").map((x) => `${x.id}x${x.nodes.length}`);
      });
    }
    if (size.width < 600) {
      row.touchTarget = await page.evaluate(() => {
        const r = document.querySelector('[data-testid="home-try-media"]')?.getBoundingClientRect();
        return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
      });
    }
    note({ scene: "home-empty", loc, size: `${size.width}x${size.height}`, ...row });
    await shot(page, `home-empty_${loc}_${size.width}_${theme}`);
    await ctx.close();
  }
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
        Image.open(os.path.join(src, f)).convert("RGB").save(os.path.join(dst, f[:-4] + ".webp"), "WEBP", quality=q, method=6)
`,
    tmp,
    OUT,
    QUALITY,
  ],
  { stdio: "inherit" },
);
rmSync(tmp, { recursive: true, force: true });
process.stdout.write(`\npictures in ${OUT}\n`);
