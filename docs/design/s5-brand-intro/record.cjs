// Records the homepage brand intro and measures LCP/CLS. Usage: node record.cjs <command-center dir> <base url> <out dir> <work dir>
const path = require("node:path");
const fs = require("node:fs");
const [cc, BASE, OUT, WORK] = process.argv.slice(2);
const { chromium } = require(path.join(cc, "node_modules", "playwright"));

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900, mobile: false },
  { name: "390x844", width: 390, height: 844, mobile: true },
];
const STRIP_MS = [0, 300, 600, 900, 1200, 1500, 1800];

const METRICS_INIT = `
  window.__lcp = []; window.__cls = 0; window.__shifts = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lcp.push({ t: e.startTime, size: e.size, el: e.element ? (e.element.tagName + '.' + (e.element.className && e.element.className.baseVal === undefined ? e.element.className : '')) : null }); }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (!e.hadRecentInput) { window.__cls += e.value; window.__shifts.push(e.value); } } }).observe({ type: 'layout-shift', buffered: true });
`;

function ctxOpts(vp, extra = {}) {
  return {
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
    ...extra,
  };
}

async function video(browser, vp, label, extra) {
  const dir = path.join(WORK, `${label}-${vp.name}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext(ctxOpts(vp, { recordVideo: { dir, size: { width: vp.width, height: vp.height } }, ...extra }));
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "commit" });
  await page.waitForTimeout(3200);
  const v = page.video();
  await ctx.close();
  const file = await v.path();
  return file;
}

async function strip(browser, vp) {
  const ctx = await browser.newContext(ctxOpts(vp));
  const page = await ctx.newPage();
  // Fake timers so the overlay's end timer only fires when told; CSS animations are paused and seeked through WAAPI.
  const now = Date.now();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
  await page.goto(BASE + "/", { waitUntil: "commit" });
  await page.waitForSelector("[data-testid='brand-intro']", { state: "attached", timeout: 10000 });
  const shift = await page.evaluate(() => {
    const el = document.querySelector("[data-testid='brand-intro']");
    const at = parseFloat(el.style.getPropertyValue("--ns-in-at"));
    for (const a of document.getAnimations()) a.pause();
    return -at;
  });
  const files = [];
  for (const T of STRIP_MS) {
    if (T >= 1700) {
      await page.clock.runFor(2500);
      await page.waitForFunction(() => !document.querySelector("[data-testid='brand-intro']"));
    } else {
      await page.evaluate(({ T, shift }) => {
        for (const a of document.getAnimations()) {
          if (!a.effect || !a.effect.target) continue;
          const t = a.effect.target;
          const host = t.closest ? t.closest(".ns-intro") : (t.parentElement && t.parentElement.closest(".ns-intro"));
          if (!host && !(t.element && t.element.closest && t.element.closest(".ns-intro"))) continue;
          a.currentTime = Math.max(0, T - shift);
        }
      }, { T, shift });
    }
    await page.waitForTimeout(60);
    const f = path.join(OUT, `strip-${vp.name}-${String(T).padStart(4, "0")}ms.png`);
    await page.screenshot({ path: f });
    files.push(f);
  }
  await ctx.close();
  return { shift, files };
}

async function measure(browser, vp, withIntro, extra = {}) {
  const ctx = await browser.newContext(ctxOpts(vp, extra));
  const page = await ctx.newPage();
  const consoleCsp = [];
  page.on("console", (m) => { if (/Content.Security.Policy|Refused to/i.test(m.text())) consoleCsp.push(m.text().slice(0, 300)); });
  await page.addInitScript(METRICS_INIT);
  if (!withIntro) await page.addInitScript(() => { try { sessionStorage.setItem("ns-intro", "1"); } catch {} });
  const t0 = Date.now();
  await page.goto(BASE + "/", { waitUntil: "commit" });
  let sawOverlay = false;
  try {
    await page.waitForSelector("[data-testid='brand-intro']", { state: "attached", timeout: 1500 });
    sawOverlay = true;
  } catch {}
  await page.waitForTimeout(4000);
  const r = await page.evaluate(() => ({
    lcp: window.__lcp,
    cls: window.__cls,
    shifts: window.__shifts,
    overlay: !!document.querySelector("[data-testid='brand-intro']"),
    cover: document.documentElement.hasAttribute("data-ns-intro"),
    seen: (() => { try { return sessionStorage.getItem("ns-intro"); } catch { return "throws"; } })(),
    h1: document.querySelector("h1") && document.querySelector("h1").textContent,
  }));
  await ctx.close();
  return { withIntro, sawOverlay, ms: Date.now() - t0, consoleCsp, ...r };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(WORK, { recursive: true });
  const browser = await chromium.launch();
  const report = { videos: [], strips: [], metrics: [] };
  for (const vp of VIEWPORTS) {
    report.videos.push({ vp: vp.name, kind: "intro", file: await video(browser, vp, "intro") });
    report.videos.push({ vp: vp.name, kind: "reduced", file: await video(browser, vp, "reduced", { reducedMotion: "reduce" }) });
    report.strips.push({ vp: vp.name, ...(await strip(browser, vp)) });
    for (let i = 0; i < 3; i++) {
      report.metrics.push({ vp: vp.name, run: i, ...(await measure(browser, vp, true)) });
      report.metrics.push({ vp: vp.name, run: i, ...(await measure(browser, vp, false)) });
    }
    report.metrics.push({ vp: vp.name, run: "reduced", ...(await measure(browser, vp, true, { reducedMotion: "reduce" })) });
  }
  await browser.close();
  fs.writeFileSync(path.join(WORK, "report.json"), JSON.stringify(report, null, 2));
  console.log("done");
})().catch((e) => { console.error(e); process.exit(1); });
