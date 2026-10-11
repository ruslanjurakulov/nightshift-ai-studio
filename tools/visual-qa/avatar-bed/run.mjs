#!/usr/bin/env node
/**
 * Evidence for the profile photo (docs/design/profile-photo): real Chromium,
 * the real Avatar and AvatarUploader, a stand-in for the two things that are
 * not in the browser (the Next router and the Supabase client), and a fake
 * /api/avatar that answers like the real route. Not part of the product: it
 * lives in tools/, ships in no bundle and runs in no CI job.
 *
 *   node tools/visual-qa/avatar-bed/run.mjs --out docs/design/profile-photo
 *
 * What it does:
 *   - Avatar: letter / photo / ring / no-letter / broken photo, all five sizes, light and dark
 *   - AvatarUploader: idle, cropping (390 and 1440, light and dark), the keyboard
 *     (focus ring, arrows, + and -), a finger drag (CDP touch events), saving,
 *     removing, and the errors (a 60000 x 60000 file refused before any decode,
 *     a rate-limited answer)
 *   - axe-core on every state: it fails on any serious or critical violation
 *   - writes small WebP screenshots (converted with Pillow) and qa-report.json
 */
import { createRequire } from "node:module";
import { execSync, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const APP = path.join(REPO, "command-center");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const OUT = path.resolve(String(arg("out", path.join(REPO, "docs", "design", "profile-photo"))));
const PORT = Number(arg("port", 5197));
mkdirSync(OUT, { recursive: true });

const appRequire = createRequire(path.join(APP, "noop.js"));
const { createServer } = appRequire("vite");
const tailwind = appRequire("@tailwindcss/postcss");

function loadPlaywright() {
  const roots = [APP, REPO];
  try {
    roots.push(execSync("npm root -g", { encoding: "utf8" }).trim());
  } catch {
    /* no npm on PATH */
  }
  for (const root of roots) {
    try {
      return createRequire(path.join(root, "noop.js"))("playwright");
    } catch {
      /* next root */
    }
  }
  throw new Error("Playwright not found");
}
function chromiumPath() {
  for (const p of [process.env.VISUAL_QA_CHROMIUM, "/opt/pw-browsers/chromium"]) {
    try {
      if (p && statSync(p).isFile()) {
        accessSync(p, constants.X_OK);
        return p;
      }
    } catch {
      /* next */
    }
  }
  return undefined;
}
const AXE = readFileSync(path.join(APP, "node_modules", "axe-core", "axe.min.js"), "utf8");

/** The marker list of a JPEG's header, up to and including SOS; null when it does not parse. */
function jpegSegments(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out = [];
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {
    const m = b[i + 1];
    out.push(m);
    if (m === 0xda) return out;
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

// ── the fake route ──────────────────────────────────────────────────────────
const state = { sample: null, fail: null, posted: [], deleted: 0 };
const bed = {
  name: "avatar-bed-api",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname === "/__bed/fail") {
        state.fail = url.searchParams.get("code") ? { code: url.searchParams.get("code"), status: Number(url.searchParams.get("status") || 400) } : null;
        res.end("ok");
        return;
      }
      if (url.pathname !== "/api/avatar") return next();
      if (req.method === "GET") {
        if (url.searchParams.get("v") === "999" || !state.sample) {
          res.statusCode = 404;
          res.end("{}");
          return;
        }
        res.setHeader("content-type", "image/jpeg");
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("cache-control", "private, max-age=3600");
        res.end(state.sample);
        return;
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      res.setHeader("content-type", "application/json");
      if (state.fail) {
        res.statusCode = state.fail.status;
        res.end(JSON.stringify({ error: state.fail.code }));
        return;
      }
      if (req.method === "POST") {
        const body = Buffer.concat(chunks);
        // a cut-down version of the real route's check: JPEG from the first byte to the last, no EXIF/XMP/comment segment
        const segs = jpegSegments(body);
        const ok = req.headers["content-type"] === "image/jpeg" && !!segs && body.at(-2) === 0xff && body.at(-1) === 0xd9 && !segs.some((m) => m === 0xe1 || m === 0xfe);
        state.posted.push({ bytes: body.length, ok, type: req.headers["content-type"], markers: segs ? segs.map((m) => m.toString(16)).join(" ") : null });
        if (ok) state.sample = body; // the "stored" photo is what the browser re-encoded
        res.end(JSON.stringify(ok ? { ok: true, version: Date.now() } : { error: "not_jpeg" }));
        return;
      }
      if (req.method === "DELETE") {
        state.deleted++;
        state.sample = null;
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 405;
      res.end("{}");
    });
  },
};

const server = await createServer({
  root: HERE,
  configFile: false,
  cacheDir: "/tmp/pp-vite-cache",
  logLevel: "warn",
  publicDir: path.join(APP, "public"),
  server: { port: PORT, strictPort: true, fs: { strict: false }, host: "127.0.0.1" },
  esbuild: { jsx: "automatic" },
  css: { postcss: { plugins: [tailwind({ base: APP })] } },
  resolve: {
    alias: [
      { find: /^next\/navigation$/, replacement: path.join(HERE, "stubs", "navigation.ts") },
      { find: /^@\/lib\/supabase\/client$/, replacement: path.join(HERE, "stubs", "supabase-client.ts") },
      { find: /^@\//, replacement: APP + "/" },
      { find: /^react$/, replacement: path.join(APP, "node_modules", "react") },
      { find: /^react\/jsx-runtime$/, replacement: path.join(APP, "node_modules", "react", "jsx-runtime.js") },
      { find: /^react\/jsx-dev-runtime$/, replacement: path.join(APP, "node_modules", "react", "jsx-dev-runtime.js") },
      { find: /^react-dom\/client$/, replacement: path.join(APP, "node_modules", "react-dom", "client.js") },
    ],
  },
  plugins: [bed],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ["--no-sandbox"] });

const report = { screens: [], axe: [], checks: [] };
const shots = [];

async function shot(page, name, clip) {
  const png = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: png, ...(clip ? { clip } : {}) });
  shots.push(name);
}

async function axe(page, label) {
  await page.evaluate(AXE);
  const res = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document, { resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help, where: v.nodes.slice(0, 2).map((n) => n.target.join(" ") + " | " + (n.any[0]?.message ?? "").slice(0, 160)) }));
  });
  const bad = res.filter((v) => v.impact === "serious" || v.impact === "critical");
  report.axe.push({ label, serious_or_critical: bad.length, all: res });
  if (bad.length) console.error(`AXE ${label}:`, JSON.stringify(bad));
}
function check(name, ok, detail = "") {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

async function newPage(width, { theme = "light", locale = "en", touch = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: width < 600 ? 844 : 900 },
    hasTouch: touch,
    isMobile: touch,
    colorScheme: theme,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => {
    console.error("PAGE ERROR", e.message);
    process.exitCode = 1;
  });
  return { page, ctx, theme, locale };
}
const open = async (p, query) => {
  await p.page.goto(`${BASE}/?${query}&theme=${p.theme}&locale=${p.locale}`);
  await p.page.waitForSelector("main");
  await p.page.evaluate(() => document.fonts.ready);
};

// ── sample pictures, drawn in the browser (no binary assets in the repo) ─────
{
  const p = await newPage(800);
  await p.page.goto("about:blank");
  const made = await p.page.evaluate(async () => {
    function paint(w, h) {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      const sky = g.createLinearGradient(0, 0, w, h);
      sky.addColorStop(0, "#f6b26b");
      sky.addColorStop(0.55, "#9b6fd1");
      sky.addColorStop(1, "#1d2b64");
      g.fillStyle = sky;
      g.fillRect(0, 0, w, h);
      g.fillStyle = "rgba(255,255,255,0.85)";
      g.beginPath();
      g.arc(w * 0.62, h * 0.34, Math.min(w, h) * 0.12, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#101826";
      g.beginPath();
      g.moveTo(0, h);
      g.lineTo(w * 0.22, h * 0.62);
      g.lineTo(w * 0.4, h * 0.8);
      g.lineTo(w * 0.62, h * 0.5);
      g.lineTo(w * 0.86, h * 0.78);
      g.lineTo(w, h * 0.66);
      g.lineTo(w, h);
      g.fill();
      // an off-centre mark, so a crop that moves is visible
      g.fillStyle = "#ffd166";
      g.fillRect(w * 0.08, h * 0.12, w * 0.07, w * 0.07);
      return c;
    }
    const toB64 = (c, type, q) =>
      new Promise((r) =>
        c.toBlob(async (b) => {
          const buf = new Uint8Array(await b.arrayBuffer());
          let s = "";
          for (const x of buf) s += String.fromCharCode(x);
          r({ type: b.type, b64: btoa(s) });
        }, type, q),
      );
    return { avatar: await toB64(paint(256, 256), "image/jpeg", 0.85), photo: await toB64(paint(1200, 800), "image/jpeg", 0.9) };
  });
  state.sample = Buffer.from(made.avatar.b64, "base64");
  state.photo = Buffer.from(made.photo.b64, "base64");
  state.initialSample = state.sample;
  check("the browser encodes JPEG (canvas.toBlob)", made.avatar.type === "image/jpeg", made.avatar.type);
  await p.ctx.close();
}

// 60000 x 60000 PNG header: a few dozen bytes that a decoder would try to allocate 14 GB for
const be32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const bomb = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), be32(13), Buffer.from("IHDR"), be32(60000), be32(60000), Buffer.from([8, 6, 0, 0, 0, 0, 0, 0, 0])]);

// ── Avatar ──────────────────────────────────────────────────────────────────
for (const theme of ["light", "dark"]) {
  const p = await newPage(900, { theme });
  await open(p, "scene=avatars");
  await p.page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await p.page.waitForTimeout(200);
  const photos = await p.page.$$eval("[data-avatar=photo]", (n) => n.length);
  const broken = await p.page.$$eval("[data-avatar=initial]", (n) => n.length);
  if (theme === "light") {
    check("photo avatars render as images (2 rows x 5 sizes)", photos === 10, String(photos));
    check("letters, icons and the failed photo all draw the circle (4 rows x 5 sizes)", broken === 20, String(broken));
  }
  await axe(p.page, `avatars-${theme}`);
  await shot(p.page, `avatars-${theme}`, { x: 0, y: 0, width: 760, height: 560 });
  await p.ctx.close();
}

// ── AvatarUploader ──────────────────────────────────────────────────────────
for (const width of [1440, 390]) {
  for (const theme of width === 1440 ? ["light", "dark"] : ["light", "dark"]) {
    const p = await newPage(width, { theme, touch: width === 390 });
    state.fail = null;
    state.sample = null;
    await open(p, "scene=uploader");
    await axe(p.page, `uploader-idle-${width}-${theme}`);
    await shot(p.page, `uploader-idle-${width}-${theme}`);

    await p.page.setInputFiles('[data-testid="avatar-file"]', { name: "mountains.jpg", mimeType: "image/jpeg", buffer: state.photo });
    await p.page.waitForSelector('[data-testid="avatar-crop"]');
    await p.page.waitForFunction(() => document.querySelector('[data-testid="avatar-crop"] img')?.complete);
    const focused = await p.page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    check(`crop opens with focus on the viewport (${width} ${theme})`, focused === "avatar-crop", String(focused));
    await axe(p.page, `uploader-cropping-${width}-${theme}`);
    await shot(p.page, `uploader-cropping-${width}-${theme}`);

    if (theme === "light") {
      // the viewport must fit the screen with the buttons reachable, and nothing may scroll sideways
      const overflow = await p.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(`no horizontal overflow while cropping (${width})`, overflow <= 0, String(overflow));
      const small = await p.page.evaluate(() =>
        [...document.querySelectorAll("button, input[type=range]")]
          .filter((e) => e.getBoundingClientRect().width > 0)
          .map((e) => ({ t: (e.textContent || e.getAttribute("type") || "").trim().slice(0, 20), h: Math.round(e.getBoundingClientRect().height) }))
          .filter((x) => x.h < 44),
      );
      check(`every control is at least 44px tall (${width})`, small.length === 0, JSON.stringify(small));
    }

    if (width === 1440 && theme === "light") {
      // keyboard: arrows move, + / - zoom, focus ring is visible
      const vp = p.page.locator('[data-testid="avatar-crop"]');
      await vp.focus();
      const ring = await vp.evaluate((e) => {
        const cs = getComputedStyle(e);
        return { style: cs.outlineStyle, width: cs.outlineWidth };
      });
      await p.page.keyboard.press("Tab"); // away and back with the keyboard, so :focus-visible applies
      await p.page.keyboard.press("Shift+Tab");
      const ring2 = await vp.evaluate((e) => ({ vis: e.matches(":focus-visible"), style: getComputedStyle(e).outlineStyle, width: getComputedStyle(e).outlineWidth }));
      check("crop viewport shows a visible focus ring from the keyboard", ring2.vis && ring2.style !== "none" && parseFloat(ring2.width) >= 2, JSON.stringify(ring2));
      const left = () => p.page.$eval('[data-testid="avatar-crop"] img', (i) => i.style.left);
      const before = await left();
      for (let i = 0; i < 3; i++) await p.page.keyboard.press("ArrowLeft");
      const after = await left();
      check("arrow keys move the photo", before !== after, `${before} -> ${after}`);
      const zoomBefore = Number(await p.page.$eval('input[type=range]', (i) => i.value));
      for (let i = 0; i < 6; i++) await p.page.keyboard.press("+");
      const zoomAfter = Number(await p.page.$eval('input[type=range]', (i) => i.value));
      check("+ zooms in, - zooms out", zoomAfter > zoomBefore + 0.5, `${zoomBefore} -> ${zoomAfter}`);
      await p.page.keyboard.press("-");
      const zoomOut = Number(await p.page.$eval('input[type=range]', (i) => i.value));
      check("- zooms out", zoomOut < zoomAfter, `${zoomAfter} -> ${zoomOut}`);
      for (let i = 0; i < 4; i++) await p.page.keyboard.press("ArrowDown");
      await shot(p.page, "uploader-cropping-keyboard-1440-light");
      // mouse drag
      const box = await vp.boundingBox();
      await p.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.page.mouse.down();
      await p.page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 - 40, { steps: 5 });
      await p.page.mouse.up();
      const dragged = await left();
      check("a mouse drag moves the photo", dragged !== after, `${after} -> ${dragged}`);
    }

    if (width === 390) {
      // a finger drag, as the browser sends it (CDP touch events -> pointer events with pointerType touch)
      const vp = p.page.locator('[data-testid="avatar-crop"]');
      const box = await vp.boundingBox();
      const cdp = await p.ctx.newCDPSession(p.page);
      const left = () => p.page.$eval('[data-testid="avatar-crop"] img', (i) => i.style.left);
      const top = () => p.page.$eval('[data-testid="avatar-crop"] img', (i) => i.style.top);
      // zoom in first so there is room to move in both directions
      await p.page.$eval('input[type=range]', (el) => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        set.call(el, "2");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const l0 = await left();
      const scrollBefore = await p.page.evaluate(() => window.scrollY);
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy }] });
      for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx - i * 12, y: cy - i * 14 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      const l1 = await left();
      const scrollAfter = await p.page.evaluate(() => window.scrollY);
      check("a finger drag moves the photo (390, touch)", l0 !== l1, `${l0} -> ${l1}`);
      check("and does not scroll the page", scrollBefore === scrollAfter, `${scrollBefore} -> ${scrollAfter}`);
      void top;
      if (theme === "light") await shot(p.page, "uploader-cropping-zoomed-390-light");
    }

    if (theme === "light") {
      // save: the browser re-encodes to a 256x256 JPEG and posts it
      state.posted.length = 0;
      await p.page.getByRole("button", { name: "Save photo" }).click();
      await p.page.waitForSelector('[data-testid="avatar-crop"]', { state: "detached" });
      const sent = state.posted[0];
      check(`save posts one image/jpeg body under 256 KB, no EXIF/comment segment (${width})`, state.posted.length === 1 && sent.ok && sent.bytes <= 262144, JSON.stringify(sent));
      await p.page.waitForSelector("[data-avatar=photo]");
      const allowed = ["e0", "e2", "db", "c0", "c4", "dd", "da"];
      check(`this browser's JPEG encoder writes only the segments the server allows (${width})`, !!sent.markers && sent.markers.split(" ").every((m) => allowed.includes(m)), sent.markers);
      const dims = await p.page.evaluate(async () => {
        const i = document.querySelector("[data-avatar=photo] img");
        await i.decode().catch(() => {});
        return { w: i.naturalWidth, h: i.naturalHeight };
      });
      check(`the stored photo is 256x256 (${width})`, dims.w === 256 && dims.h === 256, JSON.stringify(dims));
      // the toast fades in: measure it once it has settled, not mid-animation
      await p.page.waitForTimeout(900);
      await axe(p.page, `uploader-saved-${width}`);
      await shot(p.page, `uploader-saved-${width}-light`);

      // remove
      state.deleted = 0;
      await p.page.getByRole("button", { name: "Remove photo" }).click();
      await p.page.waitForSelector("[data-avatar=initial]");
      check(`remove sends DELETE and the letter comes back (${width})`, state.deleted === 1);
    }
    await p.ctx.close();
  }
}

// a phone photo with EXIF orientation 6 (rotate 90 clockwise): the preview and the saved crop must agree, and the saved file must be clean
{
  // APP1 "Exif": a TIFF header and one IFD entry, Orientation (0x0112) = 6
  const exif = Buffer.from([0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const rotated = Buffer.concat([state.photo.subarray(0, 2), exif, state.photo.subarray(2)]);
  const p = await newPage(1440, { theme: "light" });
  state.fail = null;
  state.sample = null;
  state.posted.length = 0;
  await open(p, "scene=uploader");
  await p.page.setInputFiles('[data-testid="avatar-file"]', { name: "portrait.jpg", mimeType: "image/jpeg", buffer: rotated });
  await p.page.waitForSelector('[data-testid="avatar-crop"] img');
  await p.page.waitForFunction(() => document.querySelector('[data-testid="avatar-crop"] img')?.complete);
  const nat = await p.page.$eval('[data-testid="avatar-crop"] img', (i) => ({ w: i.naturalWidth, h: i.naturalHeight }));
  check("the preview shows the EXIF-rotated picture (1200x800 file, orientation 6 -> 800x1200)", nat.w === 800 && nat.h === 1200, JSON.stringify(nat));
  await shot(p.page, "uploader-cropping-exif-rotated-1440-light");
  await p.page.getByRole("button", { name: "Save photo" }).click();
  await p.page.waitForSelector("[data-avatar=photo]");
  const sent = state.posted[0];
  check("the saved JPEG carries no EXIF", !!sent && sent.ok && !state.sample.includes(Buffer.from("Exif")), JSON.stringify(sent));
  // the moon sits at (0.62, 0.34) of the upright file; rotated 90 clockwise and cropped to the middle square it lands lower right
  const px = await p.page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/jpeg;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const at = (x, y) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    return { w: img.naturalWidth, h: img.naturalHeight, lowerRight: at(169, 174), upperRight: at(174, 87) };
  }, state.sample.toString("base64"));
  check("the saved crop follows the rotation (moon lower right, not upper right)", px.w === 256 && px.lowerRight.every((v) => v > 215) && !px.upperRight.every((v) => v > 215), JSON.stringify(px));
  await p.ctx.close();
}

// errors
for (const locale of ["en", "ru", "uz"]) {
  const p = await newPage(390, { theme: "light", locale });
  state.fail = null;
  await open(p, "scene=uploader");
  await p.page.setInputFiles('[data-testid="avatar-file"]', { name: "huge.png", mimeType: "image/png", buffer: bomb });
  await p.page.waitForSelector('[role="alert"]');
  const msg = await p.page.$eval('[role="alert"]', (e) => e.textContent);
  const cropShown = await p.page.$('[data-testid="avatar-crop"]');
  check(`a 60000x60000 file is refused with a message and no crop (${locale})`, !!msg && !cropShown, msg);
  await axe(p.page, `uploader-error-bomb-${locale}`);
  await shot(p.page, `uploader-error-bomb-390-${locale}`);
  if (locale === "en") {
    await p.page.setInputFiles('[data-testid="avatar-file"]', { name: "mountains.jpg", mimeType: "image/jpeg", buffer: state.photo });
    await p.page.waitForSelector('[data-testid="avatar-crop"]');
    await p.page.request.get(`${BASE}/__bed/fail?code=rate_limited&status=429`);
    await p.page.getByRole("button", { name: "Save photo" }).click();
    await p.page.waitForSelector('[role="alert"]');
    const msg2 = await p.page.$eval('[role="alert"]', (e) => e.textContent);
    check("a rate-limited answer shows the fixed message and keeps the crop", msg2.includes("Too many changes") && !!(await p.page.$('[data-testid="avatar-crop"]')), msg2);
    await axe(p.page, "uploader-error-rate-limited");
    await shot(p.page, "uploader-error-rate-limited-390");
    await p.page.request.get(`${BASE}/__bed/fail`);
  }
  await p.ctx.close();
}

// the Russian and Uzbek crop, for the copy
for (const locale of ["ru", "uz"]) {
  const p = await newPage(390, { theme: "light", locale });
  state.fail = null;
  state.sample = state.initialSample;
  await open(p, "scene=uploader&photo=1");
  await p.page.waitForSelector("[data-avatar=photo]");
  await shot(p.page, `uploader-idle-photo-390-${locale}`);
  await p.page.setInputFiles('[data-testid="avatar-file"]', { name: "mountains.jpg", mimeType: "image/jpeg", buffer: state.photo });
  await p.page.waitForSelector('[data-testid="avatar-crop"]');
  await axe(p.page, `uploader-cropping-390-${locale}`);
  await shot(p.page, `uploader-cropping-390-${locale}`);
  await p.ctx.close();
}

await browser.close();
await server.close();

// PNG -> small WebP
const py = `
import sys, os
from PIL import Image
out = sys.argv[1]
for name in sys.argv[2:]:
    p = os.path.join(out, name + ".png")
    im = Image.open(p).convert("RGB")
    im.save(os.path.join(out, name + ".webp"), "WEBP", quality=72, method=6)
    os.remove(p)
`;
const conv = spawnSync("python3", ["-I", "-c", py, OUT, ...shots], { encoding: "utf8" });
if (conv.status !== 0) {
  console.error(conv.stderr);
  process.exitCode = 1;
}
for (const s of shots) {
  const png = path.join(OUT, `${s}.png`);
  if (existsSync(png)) unlinkSync(png);
}

const serious = report.axe.reduce((n, a) => n + a.serious_or_critical, 0);
report.summary = { screenshots: shots.length, axe_states: report.axe.length, axe_serious_or_critical: serious, checks: report.checks.length, failed: report.checks.filter((c) => !c.ok).length };
writeFileSync(path.join(OUT, "qa-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report.summary));
if (serious > 0) process.exitCode = 1;
