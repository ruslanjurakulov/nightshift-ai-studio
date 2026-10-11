#!/usr/bin/env node
/**
 * Evidence for the account tab (docs/design/account-tab/): the customer's phone
 * header (wordmark, credit key, bell; no account button), the bottom tab bar
 * whose last tab is the account's initial, and Settings → Account.
 *
 *   --mode measure   the header row at 414/390/375/360/344 (and 320) with 12,345 and
 *                    1,180 credits: the N's height, the lockup's width, the free space
 *                    to the credit key, one row yes/no, page overflow. Printed as a table.
 *   --mode shots     WebP pictures: header + bottom bar (Settings selected and not) at
 *                    390 and 360, light and dark, en/ru/uz; Settings → Account at 390
 *                    and 1440; the keyboard focus on the Settings tab.
 *   --mode checks    axe (serious or worse), Tab reaches the Settings tab with a visible
 *                    focus ring, and sign out from Settings leaves for /login.
 *
 * Needs the app built against tools/visual-qa/fake-supabase.mjs and running (see that
 * file's header), and Pillow for the WebP conversion:
 *
 *   PORT=54511 node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54511 \
 *     NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key npx next build && npx next start -p 3611 &
 *   node tools/visual-qa/account-tab.mjs --base http://localhost:3611 --fake http://127.0.0.1:54511 --mode all
 *
 * The credit key's number is set in the page for the measurement (the fake's balance is
 * fixed): only its text, which is all the width depends on. Screenshots and reads only;
 * nothing is sent anywhere. Not part of the product; ships in no bundle.
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
const BASE = String(arg("base", "http://localhost:3611")).replace(/\/$/, "");
const FAKE = String(arg("fake", "http://127.0.0.1:54511"));
const MODE = String(arg("mode", "all"));
const OUT = path.resolve(String(arg("out", path.join(REPO, "docs", "design", "account-tab"))));
const QUALITY = String(arg("quality", "60"));
const CHANNEL = "night-owl";

function loadPlaywright() {
  const roots = [APP, REPO];
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

const browser = await chromium.launch({ executablePath: chromiumPath() });

async function open(loc, width, theme, route, { height = 844, state = "sub62" } = {}) {
  const phone = width < 600;
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: "reduce",
    hasTouch: phone,
    isMobile: phone,
  });
  await context.addCookies([
    { name: "chronos_locale", value: loc, url: BASE },
    { ...sessionCookie(FAKE, state), url: BASE },
  ]);
  const page = await context.newPage();
  await page.goto(`${BASE}/${CHANNEL}${route}`, { waitUntil: "load", timeout: 45000 });
  await page.waitForTimeout(900);
  return { context, page };
}

// ── measure ────────────────────────────────────────────────────────────────
async function measure() {
  const WIDTHS = [414, 390, 375, 360, 344, 320];
  // The number as the credit key prints it (lib/number-format.ts): a no-break space groups in ru and uz.
  const NUMBERS = {
    en: { "12,345": "12,345", "1,180": "1,180" },
    ru: { "12,345": "12 345", "1,180": "1 180" },
    uz: { "12,345": "12 345", "1,180": "1 180" },
  };
  const rows = [];
  for (const loc of ["en", "ru", "uz"]) {
    for (const width of WIDTHS) {
      const { context, page } = await open(loc, width, "light", "/home");
      for (const [label, text] of Object.entries(NUMBERS[loc])) {
        const r = await page.evaluate((text) => {
          const hdr = document.querySelector("header.shell-topbar");
          const pill = hdr.querySelector("button.shell-pill");
          pill.querySelector(".tnum").textContent = text;
          const link = hdr.querySelector("a[href$='/create']");
          const svg = link.querySelector("svg");
          const group = pill.closest(".ml-auto");
          // Only what is drawn: the palette, language and theme keys are `display: none` below `sm`.
          const buttons = [...group.querySelectorAll("button, a")].filter((b) => b.getBoundingClientRect().width > 0);
          const cy = (e) => {
            const b = e.getBoundingClientRect();
            return b.top + b.height / 2;
          };
          const sr = svg.getBoundingClientRect();
          const small = buttons
            .map((b) => b.getBoundingClientRect())
            .filter((b) => b.width > 0 && (b.height < 43.5 || b.width < 43.5)).length;
          return {
            n: +sr.height.toFixed(1),
            lockup: +sr.width.toFixed(1),
            free: Math.round(pill.getBoundingClientRect().left - sr.right),
            oneRow: [svg, ...buttons].every((e) => Math.abs(cy(e) - cy(svg)) < 4),
            headerH: Math.round(hdr.getBoundingClientRect().height),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            small,
            hasAccountButton: !!hdr.querySelector("[aria-haspopup='dialog'][title]"),
          };
        }, text);
        rows.push({ loc, width, credits: label, ...r });
      }
      await context.close();
    }
  }
  process.stdout.write("| locale | width | credits | N height | lockup width | free to credit key | one row | header h | overflow | targets <44 |\n|---|---|---|---|---|---|---|---|---|---|\n");
  for (const r of rows)
    process.stdout.write(
      `| ${r.loc} | ${r.width} | ${r.credits} | ${r.n}px | ${r.lockup}px | ${r.free}px | ${r.oneRow ? "yes" : "NO"} | ${r.headerH}px | ${r.overflow} | ${r.small} |\n`,
    );
  const bad = rows.filter((r) => !r.oneRow || r.overflow || r.small || r.hasAccountButton);
  process.stdout.write(`\n${rows.length} measurements, ${bad.length} not on one row / overflowing / with a small target / with an account button\n`);
}

// ── shots ──────────────────────────────────────────────────────────────────
async function shots() {
  mkdirSync(OUT, { recursive: true });
  const tmp = path.join(OUT, ".png-tmp");
  mkdirSync(tmp, { recursive: true });
  let count = 0;
  const grab = async (page, clip, file) => {
    await page.screenshot({ path: path.join(tmp, file), clip });
    count += 1;
  };
  // Phone: the header over the tab bar, Settings selected (on /organization) and not (on /home).
  const keep = (loc, width, theme) => loc === "en" || (width === 390 && theme === (loc === "ru" ? "light" : "dark"));
  for (const loc of ["en", "ru", "uz"]) {
    for (const width of [390, 360]) {
      for (const theme of ["light", "dark"]) {
        if (!keep(loc, width, theme)) continue;
        for (const [sel, route] of [["selected", "/organization"], ["idle", "/home"]]) {
          const { context, page } = await open(loc, width, theme, route);
          const bar = await page.locator("nav.ns-tabbar").boundingBox();
          const hdr = await page.locator("header.shell-topbar").boundingBox();
          if (bar && hdr) {
            await grab(page, { x: 0, y: 0, width, height: Math.ceil(hdr.height) }, `phone-${sel}_${loc}_${width}_${theme}_a.png`);
            await grab(page, { x: 0, y: Math.floor(bar.y), width, height: Math.ceil(bar.height) }, `phone-${sel}_${loc}_${width}_${theme}_b.png`);
          }
          await context.close();
        }
      }
    }
  }
  // Settings → Account.
  for (const [loc, width, theme] of [["en", 390, "light"], ["en", 390, "dark"], ["ru", 390, "light"], ["uz", 390, "dark"], ["en", 1440, "light"], ["en", 1440, "dark"]]) {
    const { context, page } = await open(loc, width, theme, "/organization", { height: width < 600 ? 844 : 900 });
    await page.waitForTimeout(500);
    // A fixed bar would be drawn mid-page in a full-page picture; it has its own pictures above.
    await page.addStyleTag({ content: "nav.ns-tabbar { display: none !important }" });
    await page.screenshot({ path: path.join(tmp, `settings_${loc}_${width}_${theme}.png`), fullPage: true });
    count += 1;
    await context.close();
  }
  // Keyboard focus on the Settings tab.
  {
    const { context, page } = await open("en", 390, "light", "/home");
    await page.locator("nav.ns-tabbar a").first().focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press("Tab");
    const bar = await page.locator("nav.ns-tabbar").boundingBox();
    if (bar) await grab(page, { x: 0, y: Math.floor(bar.y) - 4, width: 390, height: Math.ceil(bar.height) + 4 }, "tab-focus_en_390_light.png");
    await context.close();
  }
  execFileSync(
    "python3",
    [
      "-I",
      "-c",
      `
import sys, os
from PIL import Image
src, dst, q = sys.argv[1], sys.argv[2], int(sys.argv[3])
names = sorted(os.listdir(src))
done = set()
for f in names:
    if not f.endswith(".png"):
        continue
    if f.endswith("_b.png"):
        continue
    if f.endswith("_a.png"):
        a = Image.open(os.path.join(src, f)).convert("RGB")
        b = Image.open(os.path.join(src, f[:-6] + "_b.png")).convert("RGB")
        gap = 10
        out = Image.new("RGB", (a.width, a.height + gap + b.height), (128, 128, 128))
        out.paste(a, (0, 0)); out.paste(b, (0, a.height + gap))
        out.save(os.path.join(dst, f[:-6] + ".webp"), "WEBP", quality=q, method=6)
    else:
        Image.open(os.path.join(src, f)).convert("RGB").save(os.path.join(dst, f[:-4] + ".webp"), "WEBP", quality=q, method=6)
`,
      tmp,
      OUT,
      QUALITY,
    ],
    { stdio: "inherit" },
  );
  rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`${count} captures written to ${OUT}\n`);
}

// ── checks ─────────────────────────────────────────────────────────────────
async function checks() {
  const out = [];
  const axe = async (page, name) => {
    if (!AXE_SRC) return out.push(`${name}: axe-core not installed`);
    await page.addScriptTag({ content: AXE_SRC });
    const v = await page.evaluate(async () => {
      const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
      return r.violations.map((x) => `${x.impact}:${x.id}x${x.nodes.length}`);
    });
    const serious = v.filter((x) => /^(serious|critical)/.test(x));
    out.push(`axe ${name}: ${serious.length} serious/critical${v.length ? `  (all: ${v.join(", ")})` : ""}`);
  };
  for (const theme of ["light", "dark"]) {
    for (const [loc, route] of [["en", "/home"], ["en", "/organization"], ["ru", "/organization"], ["uz", "/organization"]]) {
      const { context, page } = await open(loc, 390, theme, route);
      await axe(page, `${route} ${loc} 390 ${theme}`);
      await context.close();
    }
  }
  {
    const { context, page } = await open("en", 1440, "light", "/organization", { height: 900 });
    await axe(page, "/organization en 1440 light");
    await context.close();
  }

  // Keyboard: Tab reaches the Settings tab; its focus ring is drawn.
  for (const theme of ["light", "dark"]) {
    const { context, page } = await open("en", 390, theme, "/home");
    await page.locator("nav.ns-tabbar a").first().focus();
    const seen = [];
    for (let i = 0; i < 5; i++) {
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        const cs = getComputedStyle(el);
        return {
          // The accessible name, as far as it matters here: aria-label, else the text without aria-hidden parts.
          name:
            el.getAttribute("aria-label") ||
            [...el.querySelectorAll("*")].filter((x) => !x.closest("[aria-hidden='true']")).map((x) => (x.children.length ? "" : x.textContent)).join("").trim(),
          inBar: !!el.closest("nav.ns-tabbar"),
          ring: el.matches(":focus-visible") ? `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}` : "none",
        };
      });
      seen.push(info);
      await page.keyboard.press("Tab");
    }
    const settings = seen.find((s) => s.inBar && s.name === "Settings");
    out.push(
      `keyboard ${theme}: Tab sequence from the first tab: ${seen.map((s) => s.name).join(" > ")}; Settings tab reached=${!!settings}; focus ring=${settings?.ring ?? "-"}`,
    );
    await context.close();
  }

  // The Settings tab's accessible name has the label and nothing else (no e-mail).
  {
    const { context, page } = await open("en", 390, "light", "/home");
    const tab = await page.evaluate(() => {
      const a = [...document.querySelectorAll("nav.ns-tabbar a")].find((x) => x.getAttribute("href")?.endsWith("/organization"));
      const named = [...a.querySelectorAll("*")].filter((x) => !x.closest("[aria-hidden='true']")).map((x) => (x.children.length ? "" : x.textContent)).join("").trim();
      return { accessibleName: named, aria: a.getAttribute("aria-label"), title: a.getAttribute("title"), initial: a.querySelector(".ns-tab-avatar")?.textContent, avatarHidden: a.querySelector(".ns-tab-avatar")?.getAttribute("aria-hidden") };
    });
    out.push(`settings tab: ${JSON.stringify(tab)}`);
    await context.close();
  }

  // Sign out from Settings → Account.
  {
    const { context, page } = await open("en", 390, "light", "/organization");
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login/, { timeout: 15000 }).catch(() => undefined);
    out.push(`sign out from Settings: now at ${new URL(page.url()).pathname}`);
    await context.close();
  }
  // Language and theme on Settings, on a phone.
  {
    const { context, page } = await open("en", 390, "light", "/organization");
    await page.getByRole("button", { name: "Language" }).click();
    await page.getByRole("option", { name: /Русский/ }).click();
    await page.waitForTimeout(1200);
    const h2 = await page.locator("#account-title").textContent();
    const before = await page.evaluate(() => document.documentElement.dataset.theme ?? document.documentElement.className);
    await page.getByRole("button", { name: /^(Тема|Theme)/ }).click();
    const after = await page.evaluate(() => document.documentElement.dataset.theme ?? document.documentElement.className);
    out.push(`language on Settings: title after choosing Russian = "${h2}"; theme toggle: ${before} -> ${after}`);
    await context.close();
  }
  process.stdout.write(out.join("\n") + "\n");
}

if (MODE === "measure" || MODE === "all") await measure();
if (MODE === "shots" || MODE === "all") await shots();
if (MODE === "checks" || MODE === "all") await checks();
await browser.close();
