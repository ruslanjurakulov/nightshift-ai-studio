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
 * Real result pictures: pass `--media <dir>` and start the app with NIGHTSHIFT_MEDIA_DIR=<dir> and MEDIA_URL_SECRET set to any
 * throwaway string of 32+ characters (local QA only; never a real key). The script draws the fake's pictures into <dir> in the
 * worker's layout (<dir>/<aa>/<uuid>/thumb.jpg, display.jpg), so a done image shows its actual thumbnail.
 *
 * Start the app with NIGHTSHIFT_AI_CHAT=on as well, and every phone scene also checks that nothing of the canvas covers the
 * Nightshift AI panel stacked above it: its last key in the band a phone's dock rides in, and its Send key at 390×500 with the
 * chat box focused (the panel's read is answered as ready by a route in this script; nothing is sent). Run with --locales en,ru,uz
 * to check the long Russian and Uzbek labels never push the page sideways.
 *
 * Fails (exit 1) on horizontal overflow, a page error, a covered panel key, or a scene whose landmark is missing. Reads and
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
    node("words", "prompt", -336, 0, { draft: "A fox crossing a snowy ridge at dawn, long shadows, film grain" }),
    node("img", "image", 0, 0, { jobId: DONE }),
    node("clip", "animate", 336, 0),
    node("lib", "asset", 0, 356, { assetId: FOX, assetKind: "image" }),
    node("vid", "video", 336, 356, { jobId: RUNNING }),
    node("enh", "enhance", 672, 0),
    node("voice", "voice", 0, 712),
  ],
  wires: [
    { id: "w0", from: "words", to: "img" },
    { id: "w1", from: "img", to: "clip" },
    { id: "w2", from: "vid", to: "enh" },
  ],
  view: { x: 0, y: 0, k: 1 },
};
const FAILURE = {
  v: 1,
  nodes: [node("img", "image", 0, 0, { jobId: DONE }), node("clip", "animate", 336, 0, { jobId: FAILED })],
  wires: [{ id: "w1", from: "img", to: "clip" }],
  view: { x: 0, y: 0, k: 1 },
};
const ONE_IMAGE = { v: 1, nodes: [node("img", "image", 0, 0, { draft: "A paper boat on a flooded street" })], wires: [], view: { x: 0, y: 0, k: 1 } };

// A finished picture alone: its card must show the real thumbnail beside "Made" (run with --media for the file).
const DONE_IMAGE = { v: 1, nodes: [node("img", "image", 0, 0, { jobId: DONE })], wires: [], view: { x: 0, y: 0, k: 1 } };
const click = (sel) => async (page) => {
  await page.click(sel);
  await page.waitForTimeout(1500);
};
// The dock's key in its three states: nothing selected, a ready node selected, and the server's quote back.
const DOCK = [
  { name: "dock-choose", layout: ONE_IMAGE, state: "canvas", desktop: true, check: '[data-testid=dock-quote][data-state="choose"]' },
  // No words yet, so the composer has nothing to price: the key offers to get the price, and stops there.
  { name: "dock-price", layout: { ...ONE_IMAGE, nodes: [node("img", "image", 0, 0)] }, state: "canvas", desktop: true, act: click('[data-node-id="img"]'), check: '[data-testid=dock-quote][data-state="price"]' },
  // The composer prices its words by itself (the free quote route); the script never presses its Generate (.ns-price-button):
  // that key creates a job. Selecting the card is enough for the server's quote to reach the dock.
  { name: "dock-make", layout: ONE_IMAGE, state: "canvas", desktop: true, act: click('[data-node-id="img"]'), check: '[data-testid=dock-quote][data-state="make"]' },
];
const UX = [
  { name: "done-image", layout: DONE_IMAGE, state: "canvas", check: '[data-node-id="img"] img, [data-testid^=flow-node-image] img' },
  ...DOCK,
  // The palette's "add" list: a closed tool says only "Not available yet"; the reason is its tooltip.
  { name: "menu-copy", layout: ONE_IMAGE, state: "canvas", act: click("[data-testid=dock-add]"), check: "[data-testid=canvas-palette]", desktop: true },
  // Quick add: the "+" by a finished picture, its menu, and the new card with its own composer (priced by the server; the wired
  // picture is its source). docs/studio/qa/quick-*.png.
  { name: "quick-plus", layout: DONE_IMAGE, state: "canvas", desktop: true, act: async (page) => page.hover('[data-node-id="img"]'), check: "[data-testid=plus-img]" },
  { name: "quick-menu", layout: DONE_IMAGE, state: "canvas", desktop: true, act: click("[data-testid=plus-img]"), check: "[data-testid=quick-menu]" },
  {
    name: "quick-composer",
    layout: DONE_IMAGE,
    state: "canvas",
    desktop: true,
    act: async (page) => {
      await click("[data-testid=plus-img]")(page);
      await click("[data-testid=quick-animate]")(page);
      await page.waitForTimeout(1500);
    },
    check: '[data-testid^="inline-composer-"]',
  },
  // On the phone the same short copy, in the "+" sheet after a picture (Edit · Upscale is closed on this fake).
  { name: "menu-copy", layout: ONE_IMAGE, state: "canvas", phone: true, act: click("[data-testid=plus-img]"), check: "[data-testid=quick-menu]" },
];
const SCENES = [
  { name: "first-run", layout: null, state: "canvas", check: "[data-testid=canvas-first-run]" },
  { name: "chain", layout: CHAIN, state: "canvas", check: '[data-wire="img->clip"], [data-testid=flow-node-animate]' },
  { name: "inspector", layout: CHAIN, state: "canvas", open: "clip", check: "[data-testid=canvas-inspector]" },
  { name: "error", layout: FAILURE, state: "canvas", open: "clip", check: '[data-status="failed"]' },
  { name: "low-credits", layout: ONE_IMAGE, state: "low", open: "img", check: "[data-testid=canvas-inspector]" },
  { name: "palette", layout: CHAIN, state: "canvas", palette: true, check: "[data-testid=canvas-palette]" },
  // The Library and the inspector both open: the board must stay usable between them.
  { name: "both", layout: CHAIN, state: "canvas", open: "clip", library: true, check: "[data-testid=canvas-library]" },
];
const ONLY = arg("scenes", null);
if (ONLY === "ux") SCENES.splice(0, SCENES.length, { name: "first-run", layout: null, state: "canvas", check: "[data-testid=canvas-first-run]" }, ...UX);
const VIEWS = [
  { width: 1440, height: 900, theme: "dark" },
  { width: 1440, height: 900, theme: "light" },
  { width: 768, height: 1024, theme: "dark" },
  { width: 390, height: 844, theme: "dark" },
];

/**
 * Is the Nightshift AI panel's last key covered where a phone's dock rides (80–140px above the screen's bottom edge)? The window is
 * made just tall enough to put the key's centre there, then elementFromPoint says what is on top. null: no panel on this page.
 * A fixed dock was caught here covering the panel's keys (the remedy for a blocked purchase); the dock is sticky to the canvas now.
 */
async function aiKeyCovered(page, width) {
  const KEYS = "[data-testid=nightshift-ai-panel] button, [data-testid=nightshift-ai-panel] a";
  const y = await page.evaluate((sel) => {
    // A modal the person opened (the inspector sheet, the palette) covers everything by design until it is closed: not a finding.
    if (document.querySelector('.cv-scrim, [aria-modal="true"], .is-sheet')) return null;
    const keys = [...document.querySelectorAll(sel)].filter((k) => k.getClientRects().length > 0);
    const last = keys[keys.length - 1];
    if (!last) return null;
    const r = last.getBoundingClientRect();
    return r.top + window.scrollY + r.height / 2;
  }, KEYS);
  if (y == null) return null;
  await page.setViewportSize({ width, height: Math.max(320, Math.round(y + 110)) });
  await page.waitForTimeout(300);
  return page.evaluate((sel) => {
    window.scrollTo(0, 0);
    const keys = [...document.querySelectorAll(sel)].filter((k) => k.getClientRects().length > 0);
    const last = keys[keys.length - 1];
    const r = last.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { covered: !top || !(last === top || last.contains(top)), by: top ? `${top.tagName}.${String(top.className).slice(0, 40)}` : "nothing", key: last.textContent.trim().slice(0, 30) };
  }, KEYS);
}

/**
 * A phone with its keyboard up (390×500): the person focuses the Nightshift AI chat box (or, when the panel has no box, its last
 * key). The Send key (or that key) must be what is on top at its centre, and the canvas's dock and lane must have stepped aside.
 * A fixed dock once sat on the box and its Send key here, so a tap landed on "Add node".
 */
async function aiTypingCovered(page, width) {
  if (!(await page.$("[data-testid=nightshift-ai-panel]"))) return null;
  // The fake has no Nightshift AI: the panel's own read is answered as a workspace whose chat is ready, so its box and Send key
  // are drawn. Its turn (POST) is refused; nothing is sent.
  await page.route(/\/api\/brain(\?.*)?$/, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ plan: { used: 1, limit: 30, max_input_chars: 2000, trial_left: null }, model: "qa", canEdit: true, canRun: true, session: null }) })
      : route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page.setViewportSize({ width, height: 500 });
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    if (document.querySelector('.cv-scrim, [aria-modal="true"], .is-sheet')) return null;
    const panel = document.querySelector("[data-testid=nightshift-ai-panel]");
    if (!panel) return null;
    const box = panel.querySelector("textarea");
    const keys = [...panel.querySelectorAll("button, a")].filter((k) => k.getClientRects().length > 0);
    const send = (box && panel.querySelector("form button[type=submit]")) || keys[keys.length - 1];
    if (!send) return null;
    // The box, else the first thing in the panel that takes focus (a Send with nothing typed is disabled and cannot).
    [box, send, ...keys].some((el) => {
      el?.focus();
      return panel.contains(document.activeElement);
    });
    // Where a keyboard-up phone leaves the key: low in the 500px window, in the band a fixed dock used to take (y 358–420).
    window.scrollTo(0, send.getBoundingClientRect().top + window.scrollY - 370);
    const r = send.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const shown = (sel) => [...document.querySelectorAll(sel)].some((el) => getComputedStyle(el).display !== "none");
    return {
      covered: !top || !(send === top || send.contains(top)),
      by: top ? `${top.tagName}.${String(top.className).slice(0, 40)}` : "nothing",
      key: send.textContent.trim().slice(0, 30),
      focused: panel.contains(document.activeElement),
      canvasShown: shown(".cv-flow-dock") || shown(".cv-lane"),
    };
  });
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: exe });
const MEDIA = arg("media", null);
if (MEDIA) {
  // Pictures for the fake's three image assets, drawn here so nothing binary is committed.
  const ART = {
    "0c000000-0000-4000-8000-0000000000a1": "radial-gradient(60% 70% at 70% 30%, #ff9d4d, transparent 60%), linear-gradient(180deg, #2a4a7f 0%, #f4c38a 70%, #e9eef8 100%)",
    "0c000000-0000-4000-8000-0000000000a2": "linear-gradient(135deg, #0a7fa0, #33d6ff 50%, #ffd23f)",
    "0c000000-0000-4000-8000-0000000000a3": "radial-gradient(circle at 50% 50%, #2f8bff 0 30%, #0a0f1c 31%)",
    // The finished clip's poster frame (the timeline lane's video segment).
    "0c000000-0000-4000-8000-0000000000a5": "radial-gradient(50% 60% at 30% 35%, #ffb56b, transparent 60%), linear-gradient(180deg, #1d2f5c 0%, #c9845a 65%, #f1e6d8 100%)",
  };
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  for (const [id, bg] of Object.entries(ART)) {
    const dir = path.join(MEDIA, id.slice(0, 2), id);
    mkdirSync(dir, { recursive: true });
    await page.setContent(`<body style="margin:0;width:640px;height:360px;background:${bg}"><div style="position:absolute;left:38%;top:52%;width:70px;height:40px;border-radius:50% 50% 40% 40%;background:#c4581c;box-shadow:30px -12px 0 -14px #c4581c"></div></body>`);
    await page.screenshot({ path: path.join(dir, "thumb.jpg"), type: "jpeg", quality: 85 });
    await page.screenshot({ path: path.join(dir, "display.jpg"), type: "jpeg", quality: 85 });
  }
  await page.close();
}
const bad = [];
const lines = [];
for (const loc of LOCALES)
  for (const v of VIEWS)
    for (const s of SCENES) {
      // The full grid only in English and dark at 1440; the rest takes the scenes the brief names.
      if ((loc !== "en" || v.theme !== "dark") && !["first-run", "chain", "inspector", "error"].includes(s.name)) continue;
      if (ONLY === "ux" && (loc !== "en" || v.theme !== "dark" || v.width === 768)) continue;
      if (s.desktop && v.width < 1000) continue;
      if (s.phone && v.width >= 600) continue;
      if (v.width === 768 && !["chain", "inspector"].includes(s.name)) continue;
      if (s.library && v.width < 1000) continue;
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
        const target = phone ? `[data-testid=flow-node-${s.layout.nodes.find((n) => n.id === s.open).kind}]` : `[data-node-id="${s.open}"]`;
        await page.click(target).catch((e) => errors.push(`open: ${e.message}`));
        await page.waitForTimeout(1800);
      }
      // Short of credits: the composer's price key and its "need more" line sit at the end of the form.
      if (s.name === "low-credits") {
        await page.evaluate(() => document.querySelector("[data-testid=canvas-inspector]")?.scrollTo(0, 1e6));
        await page.waitForTimeout(400);
      }
      if (s.library) {
        await page.click("[data-testid=dock-library]").catch((e) => errors.push(`library: ${e.message}`));
        await page.waitForTimeout(500);
      }
      if (s.act) await s.act(page).catch((e) => errors.push(`act: ${e.message}`));
      if (s.palette) {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
        await page.waitForTimeout(500);
      }
      const m = await page.evaluate((sel) => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        landmark: !!document.querySelector(sel),
        nodes: [...document.querySelectorAll("[data-node-id], [data-testid^=flow-node-]")].map((n) => `${n.getAttribute("data-kind") ?? n.getAttribute("data-testid")}:${n.getAttribute("data-status")}`),
        panel: !!document.querySelector("[data-testid=canvas-inspector] form, [data-testid=canvas-inspector] textarea"),
        // The phone's dock must not sit on the last card, and a sheet must rise from the bottom edge (not hang from the top).
        dockCovers: (() => {
          const dock = document.querySelector(".cv-flow-dock");
          const cards = [...document.querySelectorAll(".cv-fcard")];
          if (!dock || !cards.length || getComputedStyle(dock).display === "none") return false;
          window.scrollTo(0, document.documentElement.scrollHeight);
          const last = cards[cards.length - 1].getBoundingClientRect();
          const top = dock.getBoundingClientRect().top;
          window.scrollTo(0, 0);
          return last.bottom > top;
        })(),
        sheet: (() => {
          const el = document.querySelector(".is-sheet");
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(window.innerHeight - r.bottom) };
        })(),
      }), s.check);
      const name = `${s.name}-${v.width}-${v.theme}-${loc}.png`;
      await page.screenshot({ path: path.join(OUT, name), fullPage: false });
      lines.push(`${name}  overflow=${m.overflow}  landmark=${m.landmark}  form=${m.panel}  sheet=${JSON.stringify(m.sheet)}  ${m.nodes.join(" ")}`);
      if (m.dockCovers) bad.push(`${name}: the flow's dock covers the last card`);
      // Last: it resizes the window. The Nightshift AI panel (start the app with NIGHTSHIFT_AI_CHAT=on) stacks above the canvas on
      // a phone; its last key (Upgrade / Buy credits when short) must be what is on top in the band where a phone's dock rides.
      const ai = phone ? await aiKeyCovered(page, v.width) : null;
      if (ai?.covered) bad.push(`${name}: ${ai.by} covers the Nightshift AI panel's last key ("${ai.key}")`);
      const typing = phone ? await aiTypingCovered(page, v.width) : null;
      if (typing?.covered) bad.push(`${name}: typing at 390×500, ${typing.by} covers the panel's "${typing.key}"`);
      if (typing?.canvasShown) bad.push(`${name}: typing at 390×500, the canvas dock or lane is still drawn under the panel (focus in panel: ${typing.focused})`);
      if (m.sheet && (m.sheet.bottom !== 0 || m.sheet.top <= 0)) bad.push(`${name}: sheet not anchored to the bottom (${JSON.stringify(m.sheet)})`);
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
