// Records the intro at 1440x900 and muxes in its sound. Playwright's video has no audio track, so the sound is the offline
// render of the same cue (render-cue.cjs -> intro-timeline.wav, the intro's timeline from its zero), placed at the moment the
// overlay's first animation started in the page (its animationstart, which is also when the page starts the live cue), measured
// against the video's start. In the committed intro-1440x900.mp4 the visible slit came ~160 ms after that estimate (the
// screencast's frames lag), so the sound was placed by the picture instead: the slit's first frame at 1.48 s, minus the slit's
// 820 ms on the timeline, gives 650 ms, passed as [offset ms]. ffmpeg's signalstats on a box on the diagonal finds that frame.
// Usage: node record-with-sound.cjs <command-center dir> <base url> <intro-timeline.wav> <out mp4> <work dir> [offset ms]
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const [cc, BASE, WAV, OUT, WORK, OFFSET] = process.argv.slice(2);
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
    document.addEventListener("animationstart", (e) => {
      if (e.target instanceof Element && e.target.classList.contains("ns-intro-stage") && window.__startWall === undefined) {
        window.__startWall = performance.timeOrigin + performance.now();
      }
    }, true);
  });
  await page.goto(BASE + "/", { waitUntil: "commit" });
  await page.waitForTimeout(3200);
  const startWall = await page.evaluate(() => window.__startWall);
  const video = page.video();
  await ctx.close();
  await browser.close();
  if (!startWall) throw new Error("the intro did not play");
  const offsetMs = OFFSET !== undefined ? Number(OFFSET) : Math.max(0, Math.round(startWall - videoStart));
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
