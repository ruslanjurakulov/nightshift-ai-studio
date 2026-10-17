#!/usr/bin/env node
/**
 * Evidence for the owner's money and access safety sheets (docs/design/owner-money-safety/): the confirm
 * sheet for granting credits, deleting a price, the team page's blocked rows and the last two-factor
 * authenticator, against the stand-in Supabase's `owner` state.
 *
 *   --mode shots   WebP pictures (--tag after), Uzbek, 390 wide: dark and light.
 *   --mode checks  per width (320/390/1440) x theme (dark/light), in uz: no horizontal overflow, the sheet inside the
 *                  screen, Cancel left of the danger key, both keys at least 44px, the danger key's computed label
 *                  contrast >= 4.5:1, no axe violation (serious or worse), the toast area clear of the tab bar.
 *
 *   FAKE_ADMIN=1 PORT=54731 node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54731 NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key npx next dev -p 3111 &
 *   node tools/visual-qa/owner-money-safety.mjs --base http://localhost:3111 --fake http://127.0.0.1:54731 --mode checks
 *
 * Reads and screenshots only (nothing is confirmed: every sheet is cancelled). Not part of the product.
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
const BASE = String(arg("base", "http://localhost:3111")).replace(/\/$/, "");
const FAKE = String(arg("fake", "http://127.0.0.1:54731"));
const MODE = String(arg("mode", "checks"));
const TAG = String(arg("tag", "after"));
const OUT = path.resolve(String(arg("out", path.join(REPO, "docs", "design", "owner-money-safety"))));
const LOCALE = String(arg("locale", "uz"));
const STATE = String(arg("state", "owner"));
const ONLY = arg("only", "");
const CH = "chronos";

function loadPlaywright() {
  const roots = [APP, REPO];
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
  throw new Error("Playwright not found.");
}
const { chromium } = loadPlaywright();
const AXE = (() => {
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
const browser = await chromium.launch({ executablePath: chromiumPath() });

async function open(width, route, { height = 844, theme = "dark", mfa = false } = {}) {
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: "reduce", hasTouch: phone, isMobile: phone });
  await context.addCookies([
    { name: "chronos_locale", value: LOCALE, url: BASE },
    { ...sessionCookie(FAKE, STATE, 0, mfa ? { mfa: 1 } : {}), url: BASE },
  ]);
  const page = await context.newPage();
  await page.goto(`${BASE}/${CH}${route}`, { waitUntil: "load", timeout: 180000 });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.waitForTimeout(2000);
  return { context, page };
}

// Each scenario opens one sheet (and nothing is ever confirmed).
const SCENARIOS = {
  grant: {
    route: "/credits",
    async act(page) {
      await page.locator('form input[type="number"]').first().scrollIntoViewIfNeeded();
      await page.locator('form input[type="number"]').first().fill("2500");
      await page.locator('form button[type="submit"]').first().click();
      await page.waitForSelector('[role="alertdialog"]');
    },
  },
  "price-delete": {
    route: "/credits",
    async act(page) {
      const btn = page.locator("#credit-prices .btn-danger-quiet:visible").first();
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      await page.waitForSelector('[role="alertdialog"]');
    },
  },
  "last-factor": {
    route: "/security",
    mfa: true,
    async act(page) {
      await page.locator("section[aria-labelledby=sec-factors] .btn-danger-quiet").first().click();
      await page.waitForSelector('[role="alertdialog"]');
    },
  },
  banner: {
    route: "/command-center",
    async act(page) {
      await page.waitForSelector('[data-testid="admin-mfa-banner"]');
    },
    noSheet: true,
  },
  // A customer page (run with --state videos --only customer): the toast area must clear the customer tab bar too.
  customer: {
    route: "/videos",
    async act(page) {
      await page.waitForSelector(".ns-tabbar");
    },
    noSheet: true,
  },
  members: {
    route: "/members",
    async act(page) {
      await page.waitForSelector("ul.g5-rows li");
      await page.evaluate(() => {
        document.querySelector("ul.g5-rows").scrollIntoView({ block: "start" });
        window.scrollBy(0, -150);
      });
    },
    noSheet: true,
  },
};

async function shots() {
  mkdirSync(OUT, { recursive: true });
  const tmp = path.join(OUT, ".png-tmp");
  mkdirSync(tmp, { recursive: true });
  const jobs = [
    { name: "confirm-grant-390-dark", scenario: "grant", theme: "dark" },
    { name: "confirm-grant-390-light", scenario: "grant", theme: "light" },
    { name: "confirm-price-delete-390-dark", scenario: "price-delete", theme: "dark" },
    { name: "confirm-last-factor-390-dark", scenario: "last-factor", theme: "dark" },
    { name: "team-blocked-390-dark", scenario: "members", theme: "dark" },
    { name: "banner-390-dark", scenario: "banner", theme: "dark", clip: { x: 0, y: 0, width: 390, height: 260 } },
  ];
  for (const j of jobs) {
    const s = SCENARIOS[j.scenario];
    const { context, page } = await open(390, s.route, { theme: j.theme, mfa: s.mfa });
    await s.act(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(tmp, `${TAG}-${j.name}.png`), ...(j.clip ? { clip: j.clip } : {}) });
    await context.close();
  }
  execFileSync(
    "python3",
    ["-I", "-c", "import sys,os\nfrom PIL import Image\nsrc,dst,q=sys.argv[1],sys.argv[2],int(sys.argv[3])\nfor f in sorted(os.listdir(src)):\n    if f.endswith('.png'):\n        Image.open(os.path.join(src,f)).convert('RGB').save(os.path.join(dst,f[:-4]+'.webp'),'WEBP',quality=q,method=6)\n", tmp, OUT, "55"],
    { stdio: "inherit" },
  );
  rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`wrote ${jobs.length} WebP pictures to ${OUT} (${TAG})\n`);
}

function lum(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

async function checks() {
  const lines = [];
  const bad = [];
  for (const theme of ["dark", "light"]) {
    for (const width of [320, 390, 1440]) {
      for (const [name, s] of Object.entries(SCENARIOS)) {
        if (ONLY ? name !== ONLY : name === "customer") continue;
        if (name === "customer" && width >= 1024) continue; // the tab bar is a phone and tablet bar
        const { context, page } = await open(width, s.route, { height: width < 600 ? 844 : 900, theme, mfa: s.mfa });
        await s.act(page);
        await page.waitForTimeout(500);
        const r = await page.evaluate(() => {
          const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
          const dlg = document.querySelector('[role="alertdialog"]');
          const out = {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            sheet: null,
            toast: null,
            dangerLabel: null,
            dangerFill: null,
          };
          const banner = document.querySelector('[data-testid="admin-mfa-banner"]');
          if (banner) {
            const x = banner.querySelector("button");
            out.banner = { h: Math.round(banner.getBoundingClientRect().height), close: x ? [Math.round(x.getBoundingClientRect().width), Math.round(x.getBoundingClientRect().height)] : null };
          }
          const tray = document.querySelector("section.toast-viewport");
          const bar = document.querySelector(".ns-tabbar");
          if (tray && bar && getComputedStyle(bar).display !== "none") {
            const t = tray.getBoundingClientRect();
            out.toast = { trayBottom: Math.round(t.bottom - 16), barTop: Math.round(bar.getBoundingClientRect().top) };
          }
          if (dlg) {
            const b = dlg.getBoundingClientRect();
            const btns = [...dlg.querySelectorAll("button")];
            const [cancel, go] = btns.filter((x) => /btn-quiet|btn-danger|btn-primary/.test(x.className));
            const cb = cancel.getBoundingClientRect();
            const gb = go.getBoundingClientRect();
            const cs = getComputedStyle(go);
            out.sheet = {
              inside: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight,
              cancelLeft: cb.left < gb.left || cb.top < gb.top,
              minH: Math.round(Math.min(cb.height, gb.height)),
              minW: Math.round(Math.min(cb.width, gb.width)),
              names: dlg.querySelector("h2").textContent.trim().slice(0, 60),
              details: dlg.querySelectorAll("dl > div").length,
            };
            out.dangerLabel = rgb(cs.color);
            out.dangerFill = rgb(cs.backgroundColor);
          }
          return out;
        });
        let axeLine = "n/a";
        if (AXE) {
          await page.addScriptTag({ content: AXE });
          const v = await page.evaluate(async () => {
            const res = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
            return res.violations.filter((x) => x.impact === "serious" || x.impact === "critical").map((x) => `${x.id}(${x.nodes.length})`);
          });
          axeLine = v.length ? v.join(",") : "none";
          if (v.length) bad.push(`${name}@${width}/${theme}: axe ${axeLine}`);
        }
        let ratio = "-";
        if (r.dangerLabel && r.dangerFill) {
          const [hi, lo] = [lum(r.dangerLabel), lum(r.dangerFill)].sort((a, b) => b - a);
          ratio = ((hi + 0.05) / (lo + 0.05)).toFixed(2);
          if (name !== "members" && Number(ratio) < 4.5) bad.push(`${name}@${width}/${theme}: danger key contrast ${ratio}`);
        }
        const key = `${name}@${width}/${theme}`;
        if (r.overflow > 0) bad.push(`${key}: horizontal overflow ${r.overflow}px`);
        if (!s.noSheet) {
          if (!r.sheet) bad.push(`${key}: no sheet opened`);
          else {
            if (!r.sheet.inside) bad.push(`${key}: sheet leaves the screen`);
            if (!r.sheet.cancelLeft) bad.push(`${key}: Cancel is not left of the danger key`);
            if (r.sheet.minH < 48 || r.sheet.minW < 44) bad.push(`${key}: key smaller than 48px high / 44px wide (${r.sheet.minW}x${r.sheet.minH})`);
          }
        }
        if (name === "banner") {
          if (!r.banner) bad.push(`${key}: no banner`);
          else {
            if (width < 640 && r.banner.h > 96) bad.push(`${key}: banner is ${r.banner.h}px high`);
            if (!r.banner.close || r.banner.close[0] < 44 || r.banner.close[1] < 44) bad.push(`${key}: close key ${r.banner.close}`);
          }
        }
        if (r.toast && r.toast.trayBottom > r.toast.barTop) bad.push(`${key}: toast area (${r.toast.trayBottom}) overlaps the tab bar (top ${r.toast.barTop})`);
        lines.push(`| ${name}${r.banner ? ` (${r.banner.h}px)` : ""} | ${width} | ${theme} | ${r.overflow} | ${r.sheet ? `${r.sheet.minW}x${r.sheet.minH}` : "-"} | ${r.sheet ? (r.sheet.cancelLeft ? "yes" : "NO") : "-"} | ${ratio} | ${r.toast ? `${r.toast.trayBottom}<=${r.toast.barTop}` : "-"} | ${axeLine} |`);
        await context.close();
      }
    }
  }
  process.stdout.write("| scenario | width | theme | overflow px | key min WxH | Cancel left | danger contrast | toast<=tabbar | axe serious+ |\n|---|---|---|---|---|---|---|---|---|\n" + lines.join("\n") + "\n");
  process.stdout.write(bad.length ? `\nFAILED:\n${bad.join("\n")}\n` : "\nAll checks passed.\n");
  if (bad.length) process.exitCode = 1;
}

if (MODE === "shots") await shots();
else await checks();
await browser.close();
