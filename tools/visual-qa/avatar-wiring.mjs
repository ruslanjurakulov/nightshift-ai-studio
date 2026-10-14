#!/usr/bin/env node
/**
 * Evidence for the profile photo wiring (docs/design/avatar-wiring/): the photo in the bottom bar's Settings tab,
 * the sidebar card and its panel, and Settings → Your account (uploader, invite row); the initial where there is
 * no photo or the photo fails to load.
 *
 *   --mode shots    WebP pictures (390 and 1440, light and dark, en/ru/uz for Settings)
 *   --mode checks   axe (serious or worse), header on one row at 320/360/390 with 12,345 credits, the photo falling
 *                   back to the initial when /api/avatar fails, the invite shortcut landing clear of the sticky bar
 *
 * Needs the app built against tools/visual-qa/fake-supabase.mjs and running (see that file's header):
 *
 *   PORT=54521 node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54521 \
 *     NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key npx next build && npx next start -p 3621 &
 *   node tools/visual-qa/avatar-wiring.mjs --base http://localhost:3621 --fake http://127.0.0.1:54521 --mode all
 *
 * /api/avatar is answered inside the browser with a generated picture (or a 404 for the fallback case): there is no
 * Storage here, nothing is uploaded, nothing leaves the machine. Not part of the product; ships in no bundle.
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
const BASE = String(arg("base", "http://localhost:3621")).replace(/\/$/, "");
const FAKE = String(arg("fake", "http://127.0.0.1:54521"));
const MODE = String(arg("mode", "all"));
const OUT = path.resolve(String(arg("out", path.join(REPO, "docs", "design", "avatar-wiring"))));
const QUALITY = String(arg("quality", "60"));
const CHANNEL = "night-owl";
const V = 1760000000000;

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
const browser = await chromium.launch({ executablePath: chromiumPath() });

// A made-up portrait (a generated vector picture, not a real person) standing in for the private photo route.
const PORTRAIT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f2c38b"/><stop offset="1" stop-color="#d9798a"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/><circle cx="128" cy="102" r="46" fill="#5b3a2e"/><circle cx="128" cy="112" r="38" fill="#f6d9c1"/><path d="M28 256c6-62 48-92 100-92s94 30 100 92z" fill="#274b6d"/></svg>';

/** photo: "ok" (the stub answers), "fail" (404, as when the bucket is missing) or "none" (no avatar_v in the metadata). */
async function open(loc, width, theme, route, { height = 844, photo = "ok" } = {}) {
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: "reduce", hasTouch: phone, isMobile: phone });
  await context.addCookies([
    { name: "chronos_locale", value: loc, url: BASE },
    { ...sessionCookie(FAKE, "sub62", photo === "none" ? 0 : V), url: BASE },
  ]);
  await context.route("**/api/avatar**", (r) =>
    photo === "fail" ? r.fulfill({ status: 404, json: { error: "failed" } }) : r.fulfill({ contentType: "image/svg+xml", body: PORTRAIT }),
  );
  const page = await context.newPage();
  await page.goto(`${BASE}/${CHANNEL}${route}`, { waitUntil: "load", timeout: 45000 });
  await page.waitForTimeout(1000);
  return { context, page };
}

function convert(tmp) {
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
}

async function shots() {
  mkdirSync(OUT, { recursive: true });
  const tmp = path.join(OUT, ".png-tmp");
  mkdirSync(tmp, { recursive: true });
  let n = 0;
  const save = async (target, file) => {
    await target.screenshot({ path: path.join(tmp, file) });
    n += 1;
  };
  // Settings → Your account: the section, with and without a photo.
  for (const [loc, width, theme, photo] of [
    ["en", 390, "light", "ok"], ["en", 390, "dark", "ok"], ["ru", 390, "light", "ok"], ["uz", 390, "dark", "ok"],
    ["en", 390, "light", "none"], ["en", 390, "light", "fail"],
    ["en", 1440, "light", "ok"], ["en", 1440, "dark", "ok"], ["ru", 1440, "light", "ok"], ["uz", 1440, "dark", "ok"],
  ]) {
    const { context, page } = await open(loc, width, theme, "/organization", { height: width < 600 ? 844 : 900, photo });
    // A sticky bar would be drawn over the middle of an element picture.
    await page.addStyleTag({ content: "nav.ns-tabbar { display: none !important } header.shell-topbar { position: static !important }" });
    await page.waitForTimeout(400);
    await save(page.locator("section[aria-labelledby=account-title]"), `settings-${photo}_${loc}_${width}_${theme}.png`);
    await context.close();
  }
  // The bottom bar: photo, no photo, photo that failed to load, and the selected state on Settings.
  for (const [theme, photo, route, name] of [
    ["light", "ok", "/home", "bar-photo"], ["dark", "ok", "/home", "bar-photo"],
    ["light", "none", "/home", "bar-nophoto"], ["dark", "none", "/home", "bar-nophoto"],
    ["light", "fail", "/home", "bar-failed"],
    ["light", "ok", "/organization", "bar-photo-selected"], ["dark", "ok", "/organization", "bar-photo-selected"],
  ]) {
    const { context, page } = await open("en", 390, theme, route, { photo });
    const bar = await page.locator("nav.ns-tabbar").boundingBox();
    await page.screenshot({ path: path.join(tmp, `${name}_en_390_${theme}.png`), clip: { x: 0, y: Math.floor(bar.y), width: 390, height: Math.ceil(bar.height) } });
    n += 1;
    await context.close();
  }
  // The sidebar card (1440), closed, and its panel open.
  for (const theme of ["light", "dark"]) {
    const { context, page } = await open("en", 1440, theme, "/home", { height: 900 });
    await save(page.locator("aside#customer-sidebar .shell-sidebar-head, aside#customer-sidebar [data-shell-usercard]").last(), `sidebar-card_en_1440_${theme}.png`);
    await page.locator("[data-shell-usercard]").click();
    await page.waitForTimeout(700);
    await save(page.locator("[role=dialog][aria-labelledby]").last(), `sidebar-panel_en_1440_${theme}.png`);
    await context.close();
  }
  // The invite shortcut: tapped on a phone, the card lands under the sticky header.
  {
    const { context, page } = await open("en", 390, "light", "/organization");
    await page.locator("[data-testid=account-invite]").scrollIntoViewIfNeeded();
    await page.locator("[data-testid=account-invite]").click();
    await page.waitForURL(/credits#invite/, { timeout: 15000 });
    await page.waitForTimeout(1500);
    await save(page, "invite-landing_en_390_light.png");
    await context.close();
  }
  convert(tmp);
  process.stdout.write(`${n} captures written to ${OUT}\n`);
}

async function checks() {
  const out = [];
  const axe = async (page, name) => {
    await page.addScriptTag({ content: AXE_SRC });
    const v = await page.evaluate(async () => {
      const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
      return r.violations.map((x) => `${x.impact}:${x.id}x${x.nodes.length}`);
    });
    const serious = v.filter((x) => /^(serious|critical)/.test(x));
    out.push(`axe ${name}: ${serious.length} serious/critical${v.length ? `  (all: ${v.join(", ")})` : ""}`);
  };
  for (const [loc, width, theme, photo, route] of [
    ["en", 390, "light", "ok", "/organization"], ["en", 390, "dark", "ok", "/organization"], ["ru", 390, "light", "ok", "/organization"], ["uz", 390, "dark", "ok", "/organization"],
    ["en", 390, "light", "none", "/organization"], ["en", 390, "dark", "none", "/home"], ["en", 390, "light", "ok", "/home"],
    ["en", 1440, "light", "ok", "/organization"], ["en", 1440, "dark", "ok", "/home"], ["en", 1440, "dark", "none", "/organization"],
  ]) {
    const { context, page } = await open(loc, width, theme, route, { height: width < 600 ? 844 : 900, photo });
    await axe(page, `${route} ${loc} ${width} ${theme} photo=${photo}`);
    await context.close();
  }
  // The card's panel, open.
  {
    const { context, page } = await open("en", 1440, "light", "/home", { height: 900 });
    await page.locator("[data-shell-usercard]").click();
    await page.waitForTimeout(600);
    await axe(page, "/home en 1440 light, account panel open");
    await context.close();
  }

  // The header stays on one row with a long balance, with the photo drawn.
  const NUMBERS = { en: "12,345", ru: "12 345", uz: "12 345" };
  for (const loc of ["en", "ru", "uz"]) {
    for (const width of [320, 360, 390]) {
      const { context, page } = await open(loc, width, "light", "/home");
      const r = await page.evaluate((text) => {
        const hdr = document.querySelector("header.shell-topbar");
        const pill = hdr.querySelector("button.shell-pill");
        pill.querySelector(".tnum").textContent = text;
        const svg = hdr.querySelector("a[href$='/create'] svg");
        const group = pill.closest(".ml-auto");
        const buttons = [...group.querySelectorAll("button, a")].filter((b) => b.getBoundingClientRect().width > 0);
        const cy = (e) => { const b = e.getBoundingClientRect(); return b.top + b.height / 2; };
        return {
          oneRow: [svg, ...buttons].every((e) => Math.abs(cy(e) - cy(svg)) < 4),
          headerH: Math.round(hdr.getBoundingClientRect().height),
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          photoInBar: !!document.querySelector("nav.ns-tabbar img"),
        };
      }, NUMBERS[loc]);
      out.push(`header ${loc} ${width}px, ${NUMBERS[loc]} credits: one row=${r.oneRow ? "yes" : "NO"}, header ${r.headerH}px, overflow ${r.overflow}, photo in bar=${r.photoInBar}`);
      await context.close();
    }
  }

  // The fallback: a failing photo route and a user without a photo both draw the initial, never a broken image.
  for (const photo of ["fail", "none"]) {
    const { context, page } = await open("en", 390, "light", "/organization", { photo });
    const r = await page.evaluate(() => {
      const circle = document.querySelector("nav.ns-tabbar .ns-tab-avatar");
      const broken = [...document.querySelectorAll("img[src*='/api/avatar']")].filter((i) => i.complete && i.naturalWidth === 0).length;
      return { initial: circle?.textContent, imgs: document.querySelectorAll("img[src*='/api/avatar']").length, broken };
    });
    out.push(`photo=${photo}: tab circle text="${r.initial}", avatar <img> left in the page=${r.imgs}, broken images=${r.broken}`);
    await context.close();
  }

  // The Settings tab keeps its accessible name; no e-mail anywhere in the photo's markup.
  {
    const { context, page } = await open("en", 390, "light", "/home");
    const r = await page.evaluate(() => {
      const a = [...document.querySelectorAll("nav.ns-tabbar a")].find((x) => x.getAttribute("href")?.endsWith("/organization"));
      const name = [...a.querySelectorAll("*")].filter((x) => !x.closest("[aria-hidden='true']")).map((x) => (x.children.length ? "" : x.textContent)).join("").trim();
      const imgs = [...document.querySelectorAll("img[src*='/api/avatar']")];
      return { name, aria: a.getAttribute("aria-label"), title: a.getAttribute("title"), emailInImgAttrs: imgs.some((i) => /qa@|example\.com/.test(i.outerHTML)), lazy: imgs.every((i) => i.loading === "lazy") };
    });
    out.push(`settings tab: ${JSON.stringify(r)}`);
    await context.close();
  }

  // The invite shortcut: lands on the card, clear of the sticky header.
  for (const [width, h] of [[390, 844], [1440, 900]]) {
    const { context, page } = await open("en", width, "light", "/organization", { height: h });
    const link = page.locator("[data-testid=account-invite]");
    const href = await link.getAttribute("href");
    await link.scrollIntoViewIfNeeded();
    await link.click();
    await page.waitForURL(/credits#invite/, { timeout: 15000 });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const card = document.getElementById("invite");
      const hdr = document.querySelector("header.shell-topbar");
      return { cardTop: Math.round(card.getBoundingClientRect().top), headerBottom: Math.round(hdr.getBoundingClientRect().bottom) };
    });
    out.push(`invite shortcut ${width}px: href=${href}; card top ${r.cardTop}px, header bottom ${r.headerBottom}px, clear=${r.cardTop >= r.headerBottom}`);
    await context.close();
  }
  process.stdout.write(out.join("\n") + "\n");
}

if (MODE === "shots" || MODE === "all") await shots();
if (MODE === "checks" || MODE === "all") await checks();
await browser.close();
