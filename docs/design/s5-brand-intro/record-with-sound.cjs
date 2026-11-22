// Records the intro at 1440x900 and muxes in its sound. Playwright's video has no audio track, so the sound is the offline
// render of the same cue (render-cue.cjs -> intro-timeline.wav, the timeline from the moment the black cover goes up), placed
// at the moment the page's inline script put the cover up, measured in the page against the video's start.
// Usage: node record-with-sound.cjs <command-center dir> <base url> <intro-timeline.wav> <out mp4> <work dir>
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const [cc, BASE, WAV, OUT, WORK] = process.argv.slice(2);
const { chromium } = require(path.join(cc, "node_modules", "playwright"));

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    recordVideo: { dir: WORK, size: { width: 1440, height: 900 } },
  });
  const page = await ctx.newPage();
  const videoStart = Date.now();
  await page.addInitScript(() => {
    new MutationObserver(() => {
      const v = document.documentElement.getAttribute("data-ns-intro");
      if (v !== null && window.__coverWall === undefined) window.__coverWall = performance.timeOrigin + Number(v);
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-ns-intro"] });
  });
  await page.goto(BASE + "/", { waitUntil: "commit" });
  await page.waitForTimeout(3200);
  const coverWall = await page.evaluate(() => window.__coverWall);
  const video = page.video();
  await ctx.close();
  await browser.close();
  if (!coverWall) throw new Error("the intro did not play");
  const offsetMs = Math.max(0, Math.round(coverWall - videoStart));
  const webm = await video.path();
  execFileSync("ffmpeg", [
    "-loglevel", "error", "-y", "-i", webm, "-i", WAV,
    "-filter_complex", `[1:a]adelay=${offsetMs}|${offsetMs},apad[a]`,
    "-map", "0:v", "-map", "[a]", "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-preset", "slow",
    "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", OUT,
  ]);
  console.log(JSON.stringify({ offsetMs, out: OUT }));
})().catch((e) => { console.error(e); process.exit(1); });
