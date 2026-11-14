#!/usr/bin/env node
/**
 * Browser check for Studio → Projects (components/films) against tools/visual-qa/fake-supabase.mjs: the list and the canvas, per
 * language (en, uz by default), theme (light, dark) and width (360, 390, 1440). For each it records a screenshot and fails on:
 *   - horizontal overflow (anything wider than the window, fixed elements excepted);
 *   - the dock covering content: on a wide screen the board's scroll area must end at or above the dock, and no scene cell may
 *     intersect the dock; on a phone the dock must be in the page's flow (not fixed or sticky);
 *   - text under 13px inside the section;
 *   - an enabled Start key, or a digit on the quote side of the dock (pricing is not live).
 * Screenshots only; holds no secret, writes nothing anywhere but --out.
 *
 *   node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399 NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key npx next build
 *   NIGHTSHIFT_FILM_STUDIO=on npx next start -p 3417
 *   node tools/visual-qa/films.mjs --base http://localhost:3417 --out /tmp/films-shots [--langs en,uz] [--widths 390,1440]
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionCookie } from "./fake-supabase.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
let chromium;
for (const base of [path.join(REPO, "command-center", "noop.js"), "/opt/node22/lib/node_modules/noop.js"]) {
  try {
    ({ chromium } = createRequire(base)("playwright"));
    break;
  } catch {
    /* next */
  }
}
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const BASE = arg("base", "http://localhost:3417");
const OUT = arg("out", "/tmp/films-shots");
const LANGS = arg("langs", "en,uz").split(",");
const WIDTHS = arg("widths", "360,390,1440").split(",").map(Number);
const THEMES = arg("themes", "light,dark").split(",");
const FILM = "0f000000-0000-4000-8000-00000000000f";
const PAGES = [
  ["list", "/night-owl/create/projects", "videos"],
  ["canvas", `/night-owl/create/projects/${FILM}`, "videos"],
  ["canvas-empty", `/night-owl/create/projects/${FILM}`, "film_empty"],
];
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.VISUAL_QA_CHROMIUM || "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
let bad = 0;
const log = (ok, ...a) => {
  if (!ok) bad++;
  console.log(ok ? "ok  " : "FAIL", ...a);
};

for (const [name, url, state] of PAGES)
  for (const lang of LANGS)
    for (const theme of THEMES)
      for (const width of WIDTHS) {
        const phone = width < 700;
        const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone, colorScheme: theme, reducedMotion: "reduce" });
        await ctx.addCookies([{ ...sessionCookie(undefined, state), url: BASE }, { name: "chronos_locale", value: lang, url: BASE }]);
        const page = await ctx.newPage();
        await page.goto(BASE + url, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);
        const tag = `${name} ${lang} ${theme} ${width}`;
        const m = await page.evaluate(() => {
          const de = document.documentElement;
          const out = [];
          for (const el of document.body.querySelectorAll("*")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const cs = getComputedStyle(el);
            if (cs.position === "fixed" || cs.visibility === "hidden") continue;
            if (el.closest(".fs-track, .ns-tabs, .desk-bar, .fs-board-scroll, [style*='overflow']")) continue;
            if (r.right > de.clientWidth + 0.5 || r.left < -0.5) out.push(el.tagName + "." + String(el.className).slice(0, 40));
          }
          const small = [];
          const root = document.querySelector(".fs-root");
          if (root)
            for (const el of root.querySelectorAll("*")) {
              if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
              const r = el.getBoundingClientRect();
              if (r.width === 0) continue;
              const fs = parseFloat(getComputedStyle(el).fontSize);
              if (fs < 13) small.push(`${el.tagName}.${String(el.className).slice(0, 30)} ${fs}px`);
            }
          // The dock that is drawn at this width.
          const dock = [...document.querySelectorAll(".fs-dock")].find((d) => d.getBoundingClientRect().height > 0);
          let overlap = [];
          let dockPos = null;
          let scrollEnd = null;
          let start = null;
          if (dock) {
            const dr = dock.getBoundingClientRect();
            dockPos = getComputedStyle(dock).position;
            // A cell scrolled out of the board's own scroll area is clipped by it: only the part a person can see can be covered.
            const sc0 = document.querySelector(".fs-board-scroll");
            const clip = sc0 && getComputedStyle(sc0).overflowY !== "visible" ? sc0.getBoundingClientRect() : null;
            for (const c of document.querySelectorAll(".fs-cell, .fs-board-empty")) {
              const raw = c.getBoundingClientRect();
              const r = clip
                ? { top: Math.max(raw.top, clip.top), bottom: Math.min(raw.bottom, clip.bottom), left: Math.max(raw.left, clip.left), right: Math.min(raw.right, clip.right), height: Math.max(0, Math.min(raw.bottom, clip.bottom) - Math.max(raw.top, clip.top)) }
                : raw;
              const inter = !(r.bottom <= dr.top || r.top >= dr.bottom || r.right <= dr.left || r.left >= dr.right);
              if (inter && r.height > 0) overlap.push(c.className);
            }
            const sc = document.querySelector(".fs-board-scroll");
            if (sc && getComputedStyle(sc).overflowY !== "visible") scrollEnd = { scrollBottom: sc.getBoundingClientRect().bottom, dockTop: dr.top };
            const s = dock.querySelector(".fs-start");
            const q = dock.querySelector(".fs-dock-quote");
            start = { disabled: s ? s.disabled : null, digits: q ? /\d/.test(q.textContent) : null };
          }
          const styled = !!root && getComputedStyle(root).getPropertyValue("--fs-violet-a").trim().toLowerCase() === "#5546d1";
          return { overflow: out.slice(0, 5), small: small.slice(0, 5), overlap, dockPos, scrollEnd, start, hasRoot: !!root, styled };
        });
        log(m.hasRoot, tag, "section rendered");
        log(m.styled, tag, "its stylesheet loaded");
        log(m.overflow.length === 0, tag, "no horizontal overflow", m.overflow.join(" "));
        log(m.small.length === 0, tag, "nothing under 13px", m.small.join(" "));
        if (name !== "list") {
          log(m.overlap.length === 0, tag, "the dock covers no scene", m.overlap.join(" "));
          if (m.scrollEnd) log(m.scrollEnd.scrollBottom <= m.scrollEnd.dockTop + 0.5, tag, "the board ends above the dock", JSON.stringify(m.scrollEnd));
          if (phone) log(m.dockPos === "static" || m.dockPos === "relative", tag, "the phone dock is in the flow", m.dockPos);
          log(m.start?.disabled === true && m.start?.digits === false, tag, "Start is off and the quote shows no number", JSON.stringify(m.start));
        }
        await page.screenshot({ path: path.join(OUT, `${name}-${width}-${theme}-${lang}.png`), fullPage: phone });
        await ctx.close();
      }
await browser.close();
console.log(bad ? `${bad} problem(s)` : "all clear");
process.exit(bad ? 1 : 0);
