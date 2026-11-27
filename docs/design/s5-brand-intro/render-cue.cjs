// Renders the brand intro's sound (command-center/lib/site/brand-intro-sound.ts scheduleCue) offline in Chromium, from the
// same code the page runs, to WAV files.
// Usage: node render-cue.cjs <command-center dir> <out dir>
// Writes intro-cue.wav (the cue alone, from 40 ms before the riser) and intro-timeline.wav (the whole 1.8 s intro timeline,
// silent until the riser at 820 ms), which is what is muxed into intro-1440x900.mp4.
const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const [cc, out] = process.argv.slice(2);
const { chromium } = require(path.join(cc, "node_modules", "playwright"));

function wav(file, channels, rate) {
  const n = channels[0].length;
  const buf = Buffer.alloc(44 + n * channels.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * channels.length * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels.length, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * channels.length * 2, 28); buf.writeUInt16LE(channels.length * 2, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * channels.length * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (const ch of channels) { const v = Math.max(-1, Math.min(1, ch[i])); buf.writeInt16LE(Math.round(v * 32767), o); o += 2; }
  fs.writeFileSync(file, buf);
}

(async () => {
  const bundle = execFileSync(path.join(cc, "node_modules/.bin/esbuild"), [
    path.join(cc, "lib/site/brand-intro-sound.ts"), "--bundle", "--format=iife", "--global-name=Cue", "--log-level=error",
  ], { cwd: cc, encoding: "utf8" });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent("<p>render</p>");
  await page.addScriptTag({ content: bundle });
  const RATE = 48000;
  const render = (t0, seconds) =>
    page.evaluate(async ({ t0, seconds, RATE }) => {
      const ctx = new OfflineAudioContext(2, Math.round(RATE * seconds), RATE);
      window.Cue.scheduleCue(ctx, ctx.destination, t0);
      const b = await ctx.startRendering();
      return [Array.from(b.getChannelData(0)), Array.from(b.getChannelData(1))];
    }, { t0, seconds, RATE });
  fs.mkdirSync(out, { recursive: true });
  const lead = 0.04;
  const cue = await render(-(0.82 - lead), 1.7 - 0.82 + lead + 0.06);
  wav(path.join(out, "intro-cue.wav"), cue.map((c) => Float32Array.from(c)), RATE);
  const timeline = await render(0, 1.8);
  wav(path.join(out, "intro-timeline.wav"), timeline.map((c) => Float32Array.from(c)), RATE);
  await browser.close();
  console.log("rendered");
})().catch((e) => { console.error(e); process.exit(1); });
