// How long a phone stands on bare black before the intro or the page shows. 390x844, cold cache; "throttled" slows the CPU 6x
// and the network to "Fast 4G" (60 ms RTT, 9 Mbps down, 1.5 Mbps up) through the DevTools protocol, "fast" does neither.
// What the screen showed is read from a recording of it, frame by frame (40 ms apart): blank (nothing painted yet), black (the
// cover or the intro's own black), or the page (the hero heading's strip has bright text). The page's own clock cannot see a
// cover that a CSS animation lifts while the main thread is busy, so the video is the measurement.
// Usage: node measure-throttled.cjs <command-center dir> <base url> <work dir> [runs] [throttled|fast]
const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [cc, BASE, WORK, RUNS = "3", MODE = "throttled"] = process.argv.slice(2);
const { chromium } = require(path.join(cc, "node_modules", "playwright"));

const INIT = () => {
  const now = () => performance.now();
  window.__m = { cover: null, held: null, lift: null, animStart: null, fcp: null, lcp: null };
  new MutationObserver(() => {
    const v = document.documentElement.getAttribute("data-ns-intro");
    const m = window.__m;
    if (v !== null && v !== "held" && m.cover === null) m.cover = now();
    else if (v === "held" && m.held === null) m.held = now();
    else if (v === null && m.cover !== null && m.held === null && m.lift === null) m.lift = now();
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-ns-intro"] });
  document.addEventListener("animationstart", (e) => {
    if (e.target instanceof Element && e.target.classList.contains("ns-intro-stage") && window.__m.animStart === null) window.__m.animStart = now();
  }, true);
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "first-contentful-paint") window.__m.fcp = e.startTime; }).observe({ type: "paint", buffered: true });
  new PerformanceObserver((l) => { const es = l.getEntries(); window.__m.lcp = es[es.length - 1].startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
};

/** Per video frame: blank, black or page, from a strip across the hero's heading. */
function classify(webm) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-i", webm, "-vf", "crop=390:120:0:160,signalstats,metadata=print", "-an", "-f", "null", "-"], { encoding: "utf8" });
  const log = r.stdout + r.stderr;
  const rows = [];
  let t = null;
  let avg = null;
  for (const line of log.split("\n")) {
    const pt = /pts_time:([0-9.]+)/.exec(line);
    if (pt) t = Number(pt[1]);
    const a = /lavfi\.signalstats\.YAVG=([0-9.]+)/.exec(line);
    if (a) avg = Number(a[1]);
    const m = /lavfi\.signalstats\.YMAX=([0-9.]+)/.exec(line);
    if (m && t !== null) rows.push({ t, kind: avg > 200 ? "blank" : Number(m[1]) < 40 ? "black" : "page" });
  }
  return rows;
}

(async () => {
  const browser = await chromium.launch();
  const out = [];
  for (let i = 0; i < Number(RUNS); i++) {
    const dir = path.join(WORK, `${MODE}-${i}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
      recordVideo: { dir, size: { width: 390, height: 844 } },
    });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    if (MODE !== "fast") {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false, latency: 60, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8, connectionType: "cellular4g",
      });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    }
    await page.addInitScript(INIT);
    await page.goto(BASE + "/", { waitUntil: "commit" });
    await page.waitForTimeout(MODE === "fast" ? 4000 : 9000);
    const m = await page.evaluate(() => ({ ...window.__m, eff: navigator.connection && navigator.connection.effectiveType }));
    const video = page.video();
    await ctx.close();
    const rows = classify(await video.path());
    const firstBlack = rows.find((r) => r.kind === "black");
    const firstPage = rows.find((r) => r.kind === "page");
    const shown = m.animStart !== null ? "intro" : m.cover !== null ? "page (cover lifted)" : "page (no cover)";
    out.push({
      run: i,
      shown,
      // Without the intro, every black frame is bare cover. With it, the black before the logo is the gap from cover to claim.
      bareBlackMsOnVideo: m.animStart === null && firstBlack && firstPage ? Math.round((firstPage.t - firstBlack.t) * 1000) : null,
      blackFrames: rows.filter((r) => r.kind === "black").length,
      claimAfterCoverMs: m.held !== null && m.cover !== null ? Math.round(m.held - m.cover) : null,
      animStartAfterCoverMs: m.animStart !== null && m.cover !== null ? Math.round(m.animStart - m.cover) : null,
      ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === "number" ? Math.round(v) : v])),
    });
  }
  await browser.close();
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
