#!/usr/bin/env node
/**
 * Browser check for the public /studio page (and any other public page via --pages=/a,/b): per language (uz, ru, en),
 * theme (light, dark) and width (320, 390, 768, 1280) it measures horizontal overflow, targets under 44 px, layout
 * shift, the single h1, axe-core (wcag2a/aa and best-practice; serious/critical fail) and the focus ring.
 * Needs a running app (next dev is enough; set APP_ORIGIN to a non-loopback https origin to see canonical/OG tags).
 *   node tools/visual-qa/studio-page.mjs http://localhost:3517 [--shots] [--pages=/studio] [--out=DIR]
 * Screenshots go to --out (default the system temp dir). Nothing is sent anywhere.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(REPO, "command-center", "noop.js"));
let chromium;
for (const base of [path.join(REPO, "command-center", "noop.js"), "/opt/node22/lib/node_modules/noop.js"]) {
  try { ({ chromium } = createRequire(base)("playwright")); break; } catch { /* next */ }
}
const BASE = process.argv[2] || "http://localhost:3517";
const SHOTS = process.argv.includes("--shots");
const PAGES = (process.argv.find((a) => a.startsWith("--pages=")) || "--pages=/studio").slice(8).split(",");
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const OUT = (process.argv.find((a) => a.startsWith("--out=")) || `--out=${tmpdir()}`).slice(6);
const browser = await chromium.launch({ executablePath: process.env.VISUAL_QA_CHROMIUM || "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
let bad = 0;
const log = (ok, ...a) => { if (!ok) bad++; console.log(ok ? "ok  " : "FAIL", ...a); };
for (const pg of PAGES)
for (const locale of ["uz", "ru", "en"]) {
  for (const scheme of ["light", "dark"]) {
    for (const width of [320, 390, 768, 1280]) {
      const phone = width < 700;
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, isMobile: phone, hasTouch: width <= 1024, colorScheme: scheme, reducedMotion: "reduce" });
      await ctx.addCookies([{ name: "chronos_locale", value: locale, url: BASE }]);
      const page = await ctx.newPage();
      await page.addInitScript(() => {
        window.__cls = 0;
        new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto(BASE + pg, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      const tag = `${pg} ${locale} ${scheme} ${width}`;
      const m = await page.evaluate(() => {
        const de = document.documentElement;
        // elements sticking out of the viewport horizontally (excluding sr-only / hidden)
        const out = [];
        for (const el of document.body.querySelectorAll("*")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const cs = getComputedStyle(el);
          if (cs.position === "fixed" || cs.visibility === "hidden") continue;
          if (r.right > de.clientWidth + 0.5 || r.left < -0.5) out.push(el.tagName + "." + String(el.className).slice(0, 30));
        }
        const small = [];
        for (const el of document.querySelectorAll("main a, main button, main summary, header a, header button, footer a, footer summary")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const inline = getComputedStyle(el).display === "inline" && el.closest("p, li, span");
          if (!inline && r.height < 43.5) small.push((el.textContent || "").trim().slice(0, 24) + ":" + Math.round(r.height));
        }
        return { sw: de.scrollWidth, cw: de.clientWidth, out: out.slice(0, 4), small, cls: window.__cls, h1: document.querySelectorAll("h1").length };
      });
      log(m.sw <= m.cw && m.out.length === 0, tag, "overflow", m.sw, m.cw, m.out.join("|"));
      log(m.small.length === 0, tag, "targets<44", m.small.slice(0, 5).join("|"));
      log(m.cls < 0.02, tag, "CLS", m.cls.toFixed(4));
      log(m.h1 === 1, tag, "h1", m.h1);
      await page.addScriptTag({ content: AXE });
      const v = await page.evaluate(async () => (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] }, resultTypes: ["violations"] })).violations.map((x) => ({ id: x.id, impact: x.impact, n: x.nodes.length, t: x.nodes[0].target.join(" ").slice(0, 80) })));
      const serious = v.filter((x) => x.impact === "serious" || x.impact === "critical");
      log(serious.length === 0, tag, "axe serious/critical", JSON.stringify(serious), "| other:", JSON.stringify(v.filter((x) => !serious.includes(x))));
      if (width === 1280 && scheme === "light" && pg === "/studio") {
        // keyboard: tab to the first jump link; its focus ring must be visible
        await page.keyboard.press("Tab"); // skip link
        await page.focus('nav[aria-label] .sp-jump a, .sp-jump a');
        const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { o: s.outlineStyle, w: s.outlineWidth, b: s.boxShadow }; });
        log(ring.o !== "none" || ring.b !== "none", tag, "focus ring", JSON.stringify(ring));
      }
      if (SHOTS && ((width === 320 && locale === "uz" && scheme === "light") || (width === 390 && locale === "ru" && scheme === "dark") || (width === 1280 && locale === "en" && scheme === "light") || (width === 768 && locale === "en" && scheme === "dark"))) {
        await page.screenshot({ path: `${OUT}/studio-${locale}-${scheme}-${width}.jpg`, type: "jpeg", quality: 50, fullPage: true });
      }
      await ctx.close();
    }
  }
}
await browser.close();
console.log(bad === 0 ? "ALL OK" : `${bad} FAILURES`);
process.exit(bad ? 1 : 0);
