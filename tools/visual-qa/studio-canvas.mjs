#!/usr/bin/env node
/**
 * Evidence for the Nightshift Studio canvas (components/studio-canvas), against the stand-in Supabase: the
 * first run, an Image → Video chain wired, the inspector open, a node in its failed state, a workspace short
 * of credits, the ⌘K palette, and the phone's vertical flow. Each scene seeds the canvas layout the way the
 * browser keeps it (localStorage, per organization, channel and person) and reads the rest from the fake.
 *
 *   PORT=54399 node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399 NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key \
 *     npx next build && npx next start -p 3417 &
 *   node tools/visual-qa/studio-canvas.mjs --base http://localhost:3417 --out /tmp/studio-canvas-shots
 *
 * Fails (exit 1) on horizontal overflow, a page error, or a scene whose landmark is missing. Reads and
 * screenshots only; spends nothing (the fake refuses every write). Not part of the product.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionCookie } from "./fake-supabase.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..", "..", "command-center");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BASE = String(arg("base", "http://localhost:3417")).replace(/\/$/, "");
const FAKE = String(arg("fake", "http://127.0.0.1:54399"));
const OUT = path.resolve(String(arg("out", "/tmp/studio-canvas-shots")));
const LOCALES = String(arg("locales", "en,uz")).split(",");

function loadPlaywright() {
  const roots = [APP];
  try {
    roots.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim());
  } catch {
    /* local only */
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
const exe = (() => {
  try {
    return statSync("/opt/pw-browsers/chromium").isFile() ? "/opt/pw-browsers/chromium" : undefined;
  } catch {
    return undefined;
  }
})();

const ORG = "00000000-0000-4000-8000-0000000000b1";
const USER = "00000000-0000-4000-8000-0000000000aa";
const SLUG = "night-owl";
const KEY = `ns.studio.canvas.v1:${ORG}:${SLUG}:${USER}`;
const FOX = "0c000000-0000-4000-8000-0000000000a1";
const DONE = "0c000000-0000-4000-8000-0000000000c1";
const FAILED = "0c000000-0000-4000-8000-0000000000c2";
const RUNNING = "0c000000-0000-4000-8000-0000000000c3";
const node = (id, kind, x, y, extra = {}) => ({ id, kind, x, y, jobId: null, assetId: null, assetKind: null, draft: "", effectId: null, ...extra });

// An Image → Video chain: a finished picture wired into a clip, a clip being made, a voice-over, and an Edit with no input yet.
const CHAIN = {
  v: 1,
  nodes: [
    node("img", "image", 0, 0, { jobId: DONE, draft: "A fox crossing a snowy ridge at dawn" }),
    node("clip", "animate", 336, 0),
    node("lib", "asset", 0, 232, { assetId: FOX, assetKind: "image" }),
    node("vid", "video", 336, 232, { jobId: RUNNING }),
    node("enh", "enhance", 672, 0),
    node("voice", "voice", 0, 464),
  ],
  wires: [{ id: "w1", from: "img", to: "clip" }],
  view: { x: 0, y: 0, k: 1 },
};
const FAILURE = {
  v: 1,
  nodes: [node("img", "image", 0, 0, { jobId: DONE }), node("clip", "animate", 336, 0, { jobId: FAILED })],
  wires: [{ id: "w1", from: "img", to: "clip" }],
  view: { x: 0, y: 0, k: 1 },
};
const ONE_IMAGE = { v: 1, nodes: [node("img", "image", 0, 0, { draft: "A paper boat on a flooded street" })], wires: [], view: { x: 0, y: 0, k: 1 } };

const SCENES = [
  { name: "first-run", layout: null, state: "canvas", check: "[data-testid=canvas-first-run]" },
  { name: "chain", layout: CHAIN, state: "canvas", check: '[data-wire="img->clip"], [data-testid=flow-node-animate]' },
  { name: "inspector", layout: CHAIN, state: "canvas", open: "clip", check: "[data-testid=canvas-inspector]" },
  { name: "error", layout: FAILURE, state: "canvas", open: "clip", check: '[data-status="failed"]' },
  { name: "low-credits", layout: ONE_IMAGE, state: "low", open: "img", check: "[data-testid=canvas-inspector]" },
  { name: "palette", layout: CHAIN, state: "canvas", palette: true, check: "[data-testid=canvas-palette]" },
];
const VIEWS = [
  { width: 1440, height: 900, theme: "dark" },
  { width: 1440, height: 900, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const bad = [];
const lines = [];
for (const loc of LOCALES)
  for (const v of VIEWS)
    for (const s of SCENES) {
      // The full grid only in English and dark at 1440; the rest takes the scenes the brief names.
      if ((loc !== "en" || v.theme !== "dark") && !["first-run", "chain", "inspector", "error"].includes(s.name)) continue;
      const phone = v.width < 600;
      const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, colorScheme: v.theme, reducedMotion: "reduce", isMobile: phone, hasTouch: phone, deviceScaleFactor: 1 });
      await ctx.addCookies([{ name: "chronos_locale", value: loc, url: BASE }, { ...sessionCookie(FAKE, s.state), url: BASE }]);
      await ctx.addInitScript(
        ([key, layout]) => {
          try {
            window.localStorage.clear();
            if (layout) window.localStorage.setItem(key, layout);
          } catch {
            /* the canvas copes */
          }
        },
        [KEY, s.layout ? JSON.stringify(s.layout) : null],
      );
      const page = await ctx.newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await page.goto(`${BASE}/${SLUG}/studio`, { waitUntil: "load", timeout: 120000 });
      await page.waitForTimeout(1500);
      if (!phone && s.layout) await page.keyboard.press("0").catch(() => {});
      if (s.open) {
        const target = phone ? `[data-testid=flow-node-${s.layout.nodes.find((n) => n.id === s.open).kind}]` : `[data-node-id="${s.open}"] .cv-node-head`;
        await page.click(target).catch((e) => errors.push(`open: ${e.message}`));
        await page.waitForTimeout(1800);
      }
      // Short of credits: the composer's price key and its "need more" line sit at the end of the form.
      if (s.name === "low-credits") {
        await page.evaluate(() => document.querySelector("[data-testid=canvas-inspector]")?.scrollTo(0, 1e6));
        await page.waitForTimeout(400);
      }
      if (s.palette) {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
        await page.waitForTimeout(500);
      }
      const m = await page.evaluate((sel) => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        landmark: !!document.querySelector(sel),
        nodes: [...document.querySelectorAll("[data-node-id], [data-testid^=flow-node-]")].map((n) => `${n.getAttribute("data-kind") ?? n.getAttribute("data-testid")}:${n.getAttribute("data-status")}`),
        panel: !!document.querySelector("[data-testid=canvas-inspector] form, [data-testid=canvas-inspector] textarea"),
      }), s.check);
      const name = `${s.name}-${v.width}-${v.theme}-${loc}.png`;
      await page.screenshot({ path: path.join(OUT, name), fullPage: false });
      lines.push(`${name}  overflow=${m.overflow}  landmark=${m.landmark}  form=${m.panel}  ${m.nodes.join(" ")}`);
      if (m.overflow > 0) bad.push(`${name}: ${m.overflow}px sideways`);
      if (!m.landmark) bad.push(`${name}: ${s.check} missing`);
      for (const e of errors) bad.push(`${name}: ${e}`);
      await ctx.close();
    }
await browser.close();
process.stdout.write(lines.join("\n") + "\n");
if (bad.length) {
  process.stdout.write(`\nFAILED\n${bad.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`\nok: ${lines.length} pictures in ${OUT}\n`);
