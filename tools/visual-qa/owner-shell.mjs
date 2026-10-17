#!/usr/bin/env node
/**
 * Evidence for the platform owner's phone shell (docs/design/owner-mobile/): the one-row header, the visible
 * bottom tab bar, the Command Center's first screen and the All sections page, against the stand-in
 * Supabase's `owner` state (two organizations, two channels, events, workers, alerts, balances).
 *
 *   --mode shots   WebP pictures (--tag before|after names them): Uzbek, dark, Command Center at 390 and 1440,
 *                  the header at 320, the All sections page at 390, the workspace sheet at 390.
 *   --mode checks  per width (320/390/768/1024/1440) in uz: no horizontal overflow, the header on one row below
 *                  `sm`, the bottom bar visible below `lg` and absent from it, no 'Menyu' button, every
 *                  header/tab target at least 44px, no English relative time, axe (serious or worse).
 *
 *   FAKE_ADMIN=1 PORT=54511 node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54511 NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key npx next dev -p 3611 &
 *   node tools/visual-qa/owner-shell.mjs --base http://localhost:3611 --fake http://127.0.0.1:54511 --mode checks
 *
 * Reads and screenshots only. Not part of the product; ships in no bundle.
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
const MODE = String(arg("mode", "checks"));
const TAG = String(arg("tag", "after"));
const OUT = path.resolve(String(arg("out", path.join(REPO, "docs", "design", "owner-mobile"))));
const LOCALE = String(arg("locale", "uz"));
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

async function open(width, route, { height = 844, theme = "dark", loc = LOCALE } = {}) {
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: "reduce", hasTouch: phone, isMobile: phone });
  await context.addCookies([
    { name: "chronos_locale", value: loc, url: BASE },
    { ...sessionCookie(FAKE, "owner"), url: BASE },
  ]);
  const page = await context.newPage();
  await page.goto(`${BASE}/${CH}${route}`, { waitUntil: "load", timeout: 120000 });
  // The dev server's issue badge is not the product: keep it out of the pictures.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.waitForTimeout(1500);
  return { context, page };
}

async function shots() {
  mkdirSync(OUT, { recursive: true });
  const tmp = path.join(OUT, ".png-tmp");
  mkdirSync(tmp, { recursive: true });
  const jobs = [
    { name: "home-390", width: 390, route: "/command-center", clip: { x: 0, y: 0, w: 390, h: 844 } },
    { name: "header-320", width: 320, route: "/command-center", clip: { x: 0, y: 0, w: 320, h: 200 } },
    { name: "home-1440", width: 1440, height: 900, route: "/command-center", clip: { x: 0, y: 0, w: 1440, h: 900 } },
    ...(TAG === "after"
      ? [
          { name: "sections-390", width: 390, route: "/sections", clip: { x: 0, y: 0, w: 390, h: 844 } },
          { name: "picker-390", width: 390, route: "/command-center", clip: { x: 0, y: 0, w: 390, h: 844 }, act: (page) => page.click("[data-context-switcher]") },
        ]
      : []),
  ];
  for (const j of jobs) {
    const { context, page } = await open(j.width, j.route, { height: j.height ?? 844 });
    if (j.act) {
      await j.act(page);
      await page.waitForTimeout(700);
    }
    const top = j.name.startsWith("header") ? await page.evaluate(() => Math.floor(document.querySelector("header.sticky").getBoundingClientRect().top)) : j.clip.y;
    await page.screenshot({ path: path.join(tmp, `${TAG}-${j.name}.png`), clip: { x: j.clip.x, y: top, width: j.clip.w, height: j.clip.h } });
    await context.close();
  }
  execFileSync(
    "python3",
    ["-I", "-c", "import sys,os\nfrom PIL import Image\nsrc,dst,q=sys.argv[1],sys.argv[2],int(sys.argv[3])\nfor f in sorted(os.listdir(src)):\n    if f.endswith('.png'):\n        Image.open(os.path.join(src,f)).convert('RGB').save(os.path.join(dst,f[:-4]+'.webp'),'WEBP',quality=q,method=6)\n", tmp, OUT, "60"],
    { stdio: "inherit" },
  );
  rmSync(tmp, { recursive: true, force: true });
  process.stdout.write(`wrote ${jobs.length} WebP pictures to ${OUT} (${TAG})\n`);
}

async function checks() {
  const lines = [];
  const bad = [];
  for (const width of [320, 390, 768, 1024, 1440]) {
    for (const route of ["/command-center", "/sections"]) {
      const { context, page } = await open(width, route, { height: width < 600 ? 844 : 900 });
      const r = await page.evaluate(() => {
        const vis = (e) => {
          const b = e.getBoundingClientRect();
          const cs = getComputedStyle(e);
          return b.width > 0 && b.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
        };
        const hdr = document.querySelector("header.sticky");
        const bar = document.querySelector("[data-operator-tabbar]");
        const small = (root) =>
          root
            ? [...root.querySelectorAll("a[href], button")].filter(vis).filter((e) => {
                const b = e.getBoundingClientRect();
                return b.height < 43.5 || b.width < 43.5;
              }).map((e) => (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 24))
            : [];
        const menu = [...document.querySelectorAll("button")].filter(vis).filter((b) => /^(menyu|menu|меню)$/i.test((b.textContent || "").trim()));
        const text = document.body.innerText;
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          headerH: Math.round(hdr.getBoundingClientRect().height),
          barVisible: bar ? vis(bar) : false,
          smallHeader: small(hdr),
          smallBar: small(bar),
          menuButtons: menu.length,
          englishAgo: /\b\d+\s?[smhd] ago\b/.test(text),
          rawIds: /intelligence_poll|youtube_uploader/.test(text),
          strip: !!document.querySelector("[data-owner-glance]") && vis(document.querySelector("[data-owner-glance]")),
        };
      });
      let axeLine = "";
      if (AXE) {
        await page.addScriptTag({ content: AXE });
        const v = await page.evaluate(async () => {
          const res = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
          return res.violations.filter((x) => x.impact === "serious" || x.impact === "critical").map((x) => `${x.id}(${x.nodes.length})`);
        });
        axeLine = v.length ? v.join(",") : "none";
        if (v.length) bad.push(`${route}@${width}: axe ${axeLine}`);
      }
      const phone = width < 640;
      const tabletDown = width < 1024;
      if (r.overflow > 0) bad.push(`${route}@${width}: horizontal overflow ${r.overflow}px`);
      if (phone && r.headerH > 76) bad.push(`${route}@${width}: header is ${r.headerH}px (more than one row)`);
      if (r.barVisible !== tabletDown) bad.push(`${route}@${width}: tab bar visible=${r.barVisible}, expected ${tabletDown}`);
      if (r.menuButtons) bad.push(`${route}@${width}: a Menu button is visible`);
      if (r.smallBar.length || (phone && r.smallHeader.length)) bad.push(`${route}@${width}: small targets header=${r.smallHeader.join("|")} bar=${r.smallBar.join("|")}`);
      if (r.englishAgo && LOCALE !== "en") bad.push(`${route}@${width}: English relative time`);
      if (r.rawIds) bad.push(`${route}@${width}: raw agent id visible`);
      lines.push(`| ${route} | ${width} | ${r.overflow} | ${r.headerH}px | ${r.barVisible ? "yes" : "no"} | ${r.menuButtons} | ${r.smallHeader.length + r.smallBar.length} | ${r.strip ? "yes" : "no"} | ${axeLine || "n/a"} |`);
      await context.close();
    }
  }
  process.stdout.write("| route | width | overflow px | header h | tab bar | Menu buttons | targets <44 | strip | axe serious+ |\n|---|---|---|---|---|---|---|---|---|\n" + lines.join("\n") + "\n");
  process.stdout.write(bad.length ? `\nFAILED:\n${bad.join("\n")}\n` : "\nAll checks passed.\n");
  if (bad.length) process.exitCode = 1;
}

if (MODE === "shots") await shots();
else await checks();
await browser.close();
