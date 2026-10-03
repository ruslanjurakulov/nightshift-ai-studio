#!/usr/bin/env node
/**
 * Visual QA for the Command Center: real Chromium, real pages, real numbers.
 *
 * For every page × width × theme × motion setting it records a screenshot,
 * Cumulative Layout Shift and Largest Contentful Paint, horizontal overflow
 * (and the elements that cause it), axe-core accessibility violations, and
 * which animations are still running once the page has settled (constant
 * motion is a finding; with reduced motion, ANY running animation is one).
 * Optionally it clicks something and photographs the transition frame by
 * frame, to look at motion rather than guess at it.
 *
 * Not part of the product: it lives outside command-center/, ships in no
 * bundle and runs in no default CI job. It needs a running server (`next
 * start` or `next dev`) and Playwright, which it looks for in
 * command-center/node_modules, then the global install; Chromium comes from
 * $VISUAL_QA_CHROMIUM, then /opt/pw-browsers/chromium, then Playwright's own.
 * axe-core is read from command-center/node_modules (a transitive dependency
 * of eslint-plugin-jsx-a11y; nothing is installed for this).
 *
 *   node tools/visual-qa/visual-qa.mjs --base http://localhost:3000 \
 *     --pages /,/login,/chronos/home --out /tmp/vqa
 *   options:
 *     --widths 1440,390          viewport widths (height: 900 desktop, 844 phone)
 *     --themes light,dark        prefers-color-scheme
 *     --motion full,reduce       prefers-reduced-motion
 *     --settle 1500              ms to wait after load before measuring
 *     --click "<css selector>"   after measuring, click this and capture frames
 *     --frames 0,60,120,200,320  ms after the click to capture
 *     --full                     full-page screenshots (default: viewport)
 *     --no-axe                   skip the accessibility scan
 *     --fake-session [url]       sign in to the customer shell against
 *                                tools/visual-qa/fake-supabase.mjs (the app must
 *                                be built pointing at it; see that file)
 *     --fake-state <name>        with --fake-session: the account state the fake
 *                                answers for (the Usage page's states; see
 *                                tools/visual-qa/fake-supabase.mjs)
 *     --locale en|ru|uz          the interface language (the app's own cookie)
 *     --prefix <text>            put this before every screenshot's name
 *     --click-first "<css>"      click this once the page has settled, before measuring
 *     --fail-on serious          exit 1 on axe violations of this impact or
 *                                worse, any overflow, or CLS > 0.1 (for CI use)
 *
 * Writes <out>/report.json and <out>/report.md next to the PNGs.
 */
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const APP = path.join(REPO, "command-center");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}
const list = (v) => String(v).split(",").map((s) => s.trim()).filter(Boolean);

const BASE = String(arg("base", "http://localhost:3000")).replace(/\/$/, "");
const PAGES = list(arg("pages", "/"));
const WIDTHS = list(arg("widths", "1440,390")).map(Number);
const THEMES = list(arg("themes", "light,dark"));
const MOTION = list(arg("motion", "full,reduce"));
const SETTLE = Number(arg("settle", 1500));
const CLICK = arg("click", null);
const FRAMES = list(arg("frames", "0,60,120,200,320")).map(Number);
const FULL = arg("full", false) === true;
const AXE = arg("no-axe", false) !== true;
const FAIL_ON = arg("fail-on", null);
// The signed-in customer shell, against tools/visual-qa/fake-supabase.mjs.
const FAKE_SESSION = arg("fake-session", false);
const FAKE_STATE = String(arg("fake-state", "")) === "true" ? "" : String(arg("fake-state", ""));
const LOCALE = String(arg("locale", "")) === "true" ? "" : String(arg("locale", ""));
const PREFIX = String(arg("prefix", "")) === "true" ? "" : String(arg("prefix", ""));
const CLICK_FIRST = arg("click-first", null);
// The app's own language cookie (command-center/lib/i18n/core.ts LOCALE_COOKIE).
const LOCALE_COOKIE = "chronos_locale";
const OUT = path.resolve(String(arg("out", path.join(process.env.TMPDIR || "/tmp", `visual-qa-${Date.now()}`))));

function loadPlaywright() {
  const roots = [APP, REPO];
  try {
    roots.push(execSync("npm root -g", { encoding: "utf8" }).trim());
  } catch {
    // no npm on PATH: the local roots only
  }
  for (const root of roots) {
    try {
      return createRequire(path.join(root, "noop.js"))("playwright");
    } catch {
      // try the next root
    }
  }
  throw new Error("Playwright not found (command-center/node_modules or the global npm root).");
}

function chromiumPath() {
  for (const p of [process.env.VISUAL_QA_CHROMIUM, "/opt/pw-browsers/chromium"]) {
    // Only an executable file: on some machines that path is a browsers
    // directory, which Playwright finds by itself via PLAYWRIGHT_BROWSERS_PATH.
    try {
      if (p && statSync(p).isFile()) {
        accessSync(p, constants.X_OK);
        return p;
      }
    } catch {
      // not usable: try the next one
    }
  }
  return undefined; // Playwright's own download
}

const AXE_SRC = (() => {
  const p = path.join(APP, "node_modules", "axe-core", "axe.min.js");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
})();

// Collected in the page from the first byte: layout shifts and LCP entries.
const OBSERVE = `
  window.__vqa = { cls: 0, shifts: [], lcp: null, lcpEl: null };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        window.__vqa.cls += e.value;
        window.__vqa.shifts.push({ value: e.value, at: Math.round(e.startTime),
          nodes: (e.sources || []).map((s) => s.node && s.node.nodeName ? (s.node.nodeName + (s.node.className && typeof s.node.className === 'string' ? '.' + s.node.className.split(' ').slice(0, 3).join('.') : '')) : '?') });
      }
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => {
      const e = l.getEntries().at(-1);
      if (!e) return;
      window.__vqa.lcp = Math.round(e.startTime);
      const n = e.element;
      window.__vqa.lcpEl = n ? n.nodeName + (n.className && typeof n.className === 'string' ? '.' + n.className.split(' ').slice(0, 3).join('.') : '') : null;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}
`;

function slug(s) {
  return s.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
}

async function measure(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth - vw;
    const culprits = [];
    if (overflow > 0) {
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > vw + 1) {
          const cs = getComputedStyle(el);
          if (cs.position === "fixed" && r.left >= vw) continue;
          culprits.push(`${el.nodeName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className).split(" ").slice(0, 3).join(".")} right=${Math.round(r.right)}`);
          if (culprits.length >= 8) break;
        }
      }
    }
    const running = document
      .getAnimations()
      .filter((a) => a.playState === "running")
      .map((a) => {
        const t = a.effect && a.effect.target;
        const timing = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {};
        return {
          name: a.animationName || a.transitionProperty || a.constructor.name,
          infinite: timing.iterations === Infinity,
          duration: typeof timing.duration === "number" ? Math.round(timing.duration) : null,
          target: t ? t.nodeName.toLowerCase() + "." + String(t.className).split(" ").slice(0, 2).join(".") : null,
        };
      });
    // Touch targets under 44px (design rule, WCAG 2.5.5): every visible control that is not a link
    // inside running text. Reported, not failed on: a few (a bell's badge) are deliberate.
    const small = [];
    for (const el of document.querySelectorAll("a[href], button, [role=button], [role=switch], summary, select, input:not([type=hidden])")) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || el.closest("[hidden], [aria-hidden=true]")) continue;
      if (r.height >= 43.5 && r.width >= 43.5) continue;
      if (el.tagName === "A" && el.closest("p, li") && cs.display === "inline") continue;
      small.push(`${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}"`);
      if (small.length >= 10) break;
    }
    // Text fields under 16px make iOS zoom the page on focus.
    const smallFields = [...document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select")]
      .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16 && el.getBoundingClientRect().width > 0)
      .map((el) => `${el.tagName.toLowerCase()} ${getComputedStyle(el).fontSize}`)
      .slice(0, 5);
    return { cls: Number(window.__vqa.cls.toFixed(4)), shifts: window.__vqa.shifts.slice(0, 5), lcp: window.__vqa.lcp, lcpEl: window.__vqa.lcpEl, overflow, culprits, running, small, smallFields };
  });
}

async function axe(page) {
  if (!AXE || !AXE_SRC) return null;
  await page.addScriptTag({ content: AXE_SRC });
  const res = await page.evaluate(async () => {
    const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, sample: v.nodes[0] && v.nodes[0].target && v.nodes[0].target.join(" ") }));
  });
  return res;
}

const IMPACT = ["minor", "moderate", "serious", "critical"];

async function main() {
  const { chromium } = loadPlaywright();
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ executablePath: chromiumPath() });
  const results = [];
  for (const route of PAGES) {
    for (const width of WIDTHS) {
      for (const theme of THEMES) {
        for (const motion of MOTION) {
          const phone = width < 600;
          const context = await browser.newContext({
            viewport: { width, height: phone ? 844 : 900 },
            deviceScaleFactor: 1,
            colorScheme: theme === "dark" ? "dark" : "light",
            reducedMotion: motion === "reduce" ? "reduce" : "no-preference",
            hasTouch: phone,
            isMobile: phone,
          });
          await context.addInitScript(OBSERVE);
          if (FAKE_SESSION) {
            const { sessionCookie } = await import("./fake-supabase.mjs");
            const c = sessionCookie(FAKE_SESSION === true ? undefined : String(FAKE_SESSION), FAKE_STATE);
            await context.addCookies([{ ...c, url: BASE }]);
          }
          if (LOCALE) await context.addCookies([{ name: LOCALE_COOKIE, value: LOCALE, url: BASE }]);
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
          page.on("console", (m) => {
            if (m.type() === "error") errors.push(m.text().slice(0, 200));
          });
          const name = `${PREFIX}${slug(route)}_${width}_${theme}_${motion}`;
          const row = { route, width, theme, motion, file: `${name}.png` };
          try {
            const resp = await page.goto(BASE + route, { waitUntil: "load", timeout: 45000 });
            row.status = resp ? resp.status() : null;
            await page.waitForTimeout(SETTLE);
            if (CLICK_FIRST) {
              const first = page.locator(String(CLICK_FIRST)).first();
              if (await first.count()) await first.click();
              await page.waitForTimeout(SETTLE);
            }
            Object.assign(row, await measure(page));
            await page.screenshot({ path: path.join(OUT, row.file), fullPage: FULL });
            row.axe = await axe(page);
            if (CLICK) {
              const target = page.locator(String(CLICK)).first();
              if (await target.count()) {
                row.frames = [];
                const t0 = Date.now();
                await target.click({ noWaitAfter: true });
                for (const ms of FRAMES) {
                  const wait = ms - (Date.now() - t0);
                  if (wait > 0) await page.waitForTimeout(wait);
                  const f = `${name}_click_${ms}ms.png`;
                  await page.screenshot({ path: path.join(OUT, f) });
                  row.frames.push({ ms, at: Date.now() - t0, file: f });
                }
                await page.waitForTimeout(SETTLE);
                row.afterClick = await measure(page);
                await page.screenshot({ path: path.join(OUT, `${name}_click_settled.png`) });
              } else {
                row.frames = "selector not found";
              }
            }
          } catch (e) {
            row.error = String(e.message || e).slice(0, 300);
          }
          row.consoleErrors = errors.slice(0, 5);
          results.push(row);
          await context.close();
          process.stdout.write(`${name}: ${row.error ? "ERROR " + row.error : `cls=${row.cls} lcp=${row.lcp}ms overflow=${row.overflow} axe=${row.axe ? row.axe.length : "-"} running=${row.running ? row.running.length : "-"} small=${row.small ? row.small.length : "-"} fields<16=${row.smallFields ? row.smallFields.length : "-"}`}\n`);
        }
      }
    }
  }
  await browser.close();

  writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
  const md = [
    `# Visual QA — ${BASE}`,
    "",
    "| page | width | theme | motion | CLS | LCP ms (element) | overflow px | axe (serious+) | running animations after settle | targets < 44px | fields < 16px |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...results.map((r) =>
      r.error
        ? `| ${r.route} | ${r.width} | ${r.theme} | ${r.motion} | error: ${r.error} |||||`
        : `| ${r.route} | ${r.width} | ${r.theme} | ${r.motion} | ${r.cls} | ${r.lcp ?? "–"} (${r.lcpEl ?? "–"}) | ${r.overflow}${r.culprits.length ? " " + r.culprits[0] : ""} | ${r.axe ? r.axe.filter((v) => IMPACT.indexOf(v.impact) >= 2).map((v) => `${v.id}×${v.nodes}`).join(", ") || "0" : "–"} | ${r.running.map((a) => `${a.name}${a.infinite ? "∞" : ""}@${a.target}`).join(", ") || "none"} | ${(r.small || []).length ? r.small.join("; ") : "0"} | ${(r.smallFields || []).length ? r.smallFields.join("; ") : "0"} |`,
    ),
  ].join("\n");
  writeFileSync(path.join(OUT, "report.md"), md + "\n");
  process.stdout.write(`\nreport: ${path.join(OUT, "report.md")}\n`);

  if (FAIL_ON) {
    const floor = IMPACT.indexOf(String(FAIL_ON));
    const bad = results.filter(
      (r) => r.error || r.overflow > 0 || r.cls > 0.1 || (r.axe || []).some((v) => IMPACT.indexOf(v.impact) >= floor),
    );
    if (bad.length) {
      process.stdout.write(`${bad.length} run(s) failed the gate\n`);
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
