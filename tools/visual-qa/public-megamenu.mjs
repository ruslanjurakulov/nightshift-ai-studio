#!/usr/bin/env node
/**
 * The public header's panels and the phone sheet's sections (components/legal/PublicMegaMenu.tsx, PublicMenu.tsx) in
 * real Chromium against a built app. Not in CI (it needs a running server); run by hand before a header change ships.
 *
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=x npx next build \
 *     && npx next start -p 3517 &
 *   node tools/visual-qa/public-megamenu.mjs --base http://localhost:3517                 # measure, exits 1 on a failure
 *   node tools/visual-qa/public-megamenu.mjs --base ... --mode shots --out docs/design/s5-megamenu
 *
 * measure, per language (en, ru, uz):
 *   - 360 and 390 px: no horizontal scroll with the page closed, with the sheet open, and with every section expanded;
 *     the sheet's primary key is inside the viewport (pinned at its foot);
 *   - 820, 1024 and 1440 px: each panel opens from the keyboard (ArrowDown), its frame lies inside the viewport, the header's
 *     height and the main column's top do not move (no layout shift), and there is still no horizontal scroll.
 * Signed out, no backend needed: the header reads nothing. Nothing is sent anywhere; screenshots stay on disk.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BASE = String(arg("base", "http://localhost:3517")).replace(/\/$/, "");
const MODE = String(arg("mode", "measure"));
const OUT = path.resolve(String(arg("out", path.join(REPO, "docs/design/s5-megamenu"))));
const LOCALES = String(arg("locales", "en,ru,uz")).split(",");
const PAGE = String(arg("page", "/pricing"));

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
const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumPath() });

async function open(width, { locale, scheme = "light", dsf = 1, height }) {
  const phone = width < 768;
  const context = await browser.newContext({
    viewport: { width, height: height ?? (phone ? 844 : 900) },
    deviceScaleFactor: dsf,
    isMobile: phone,
    hasTouch: phone,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await context.addCookies([{ name: "chronos_locale", value: locale, url: BASE }]);
  // The site's theme is its own saved choice (lib/theme.ts, dark by default), not the system's: set it before paint.
  await context.addInitScript((t) => localStorage.setItem("chronos_theme", t), scheme);
  const page = await context.newPage();
  await page.goto(BASE + PAGE, { waitUntil: "networkidle" });
  return { context, page };
}

const hscroll = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const failures = [];
const fail = (msg) => {
  failures.push(msg);
  console.log(`FAIL ${msg}`);
};

async function measure() {
  for (const locale of LOCALES) {
    for (const width of [360, 390]) {
      const { context, page } = await open(width, { locale });
      const tag = `${locale} ${width}px`;
      if ((await hscroll(page)) > 0) fail(`${tag}: horizontal scroll, closed`);
      await page.click(".st-menu-btn");
      if ((await hscroll(page)) > 0) fail(`${tag}: horizontal scroll, sheet open`);
      for (const b of await page.$$(".st-menu-sec-btn")) await b.click();
      const r = await page.evaluate(() => {
        const sheet = document.querySelector(".st-menu-sheet");
        const key = document.querySelector(".st-menu-foot .st-key")?.getBoundingClientRect();
        return {
          over: sheet.scrollWidth - sheet.clientWidth,
          key: key ? { left: key.left, right: key.right, bottom: key.bottom } : null,
          vw: innerWidth,
          vh: innerHeight,
        };
      });
      if (r.over > 0) fail(`${tag}: the sheet scrolls sideways with every section open (${r.over}px)`);
      if (!r.key || r.key.left < 0 || r.key.right > r.vw || r.key.bottom > r.vh + 0.5) fail(`${tag}: the sheet's primary key is not in view`);
      console.log(`ok   ${tag}: no sideways scroll, closed, open, all sections expanded`);
      await context.close();
    }
    for (const width of [820, 1024, 1440]) {
      const { context, page } = await open(width, { locale });
      const tag = `${locale} ${width}px`;
      const before = await page.evaluate(() => ({ h: document.querySelector(".st-header").offsetHeight, main: document.querySelector("main").getBoundingClientRect().top }));
      const triggers = await page.$$(".st-mm-trigger");
      for (const t of triggers) {
        const name = (await t.textContent()).trim();
        await t.focus();
        await page.keyboard.press("ArrowDown");
        const m = await page.evaluate(() => {
          const f = document.querySelector(".st-mm").getBoundingClientRect();
          return {
            open: document.querySelector(".st-mm").getAttribute("data-open"),
            focusIn: document.querySelector(".st-mm").contains(document.activeElement),
            f: { left: f.left, right: f.right, bottom: f.bottom },
            h: document.querySelector(".st-header").offsetHeight,
            main: document.querySelector("main").getBoundingClientRect().top,
            vw: document.documentElement.clientWidth,
          };
        });
        if (m.open !== "true" || !m.focusIn) fail(`${tag} ${name}: ArrowDown did not open the panel and move focus into it`);
        if (m.f.left < 0 || m.f.right > m.vw + 0.5) fail(`${tag} ${name}: the frame leaves the viewport`);
        if (m.h !== before.h || Math.abs(m.main - before.main) > 0.5) fail(`${tag} ${name}: opening moved the page (header ${before.h}->${m.h}, main ${before.main}->${m.main})`);
        if ((await hscroll(page)) > 0) fail(`${tag} ${name}: horizontal scroll with the panel open`);
        await page.keyboard.press("Escape");
      }
      console.log(`ok   ${tag}: ${triggers.length} panels open from the keyboard, nothing moves`);
      await context.close();
    }
  }
}

async function shots() {
  mkdirSync(OUT, { recursive: true });
  const save = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: "jpeg", quality: 82 });
  for (const scheme of ["light", "dark"]) {
    {
      const { context, page } = await open(1440, { locale: "en", scheme, dsf: 2, height: 560 });
      await save(page, `1440-${scheme}-closed`);
      for (const t of await page.$$(".st-mm-trigger")) {
        const id = await t.getAttribute("data-mm");
        await t.focus();
        await page.keyboard.press("Enter");
        // The pointer rests on the trigger, as a visitor's would; focus stays on the trigger (its ring is visible).
        await page.waitForTimeout(80);
        await save(page, `1440-${scheme}-${id}`);
        await page.keyboard.press("Escape");
      }
      await context.close();
    }
    {
      const { context, page } = await open(390, { locale: "en", scheme, dsf: 2 });
      await save(page, `390-${scheme}-closed`);
      await page.click(".st-menu-btn");
      await page.click(".st-menu-sec-btn >> nth=0");
      await save(page, `390-${scheme}-sheet-studio`);
      await context.close();
    }
  }
  console.log(`screenshots in ${OUT}`);
}

if (MODE === "shots") await shots();
else await measure();
await browser.close();
if (failures.length) {
  console.log(`${failures.length} failure(s)`);
  process.exit(1);
}
