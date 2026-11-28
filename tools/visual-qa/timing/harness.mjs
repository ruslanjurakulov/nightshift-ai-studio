/**
 * Timing harness: what a person sees, second by second, measured in the preinstalled Chromium against a locally built app and the
 * stand-in Supabase (tools/visual-qa/fake-supabase.mjs). Measurement only (CLAUDE.md rule 8). The harness itself never calls a
 * model or a vendor; a scenario that drives a paid path must answer that route in the browser (see brain-flow.mjs).
 *
 * What it gives a scenario:
 *   - startStack / stopStack: the fake and `next start`, each on a port checked free by a listen test (`ss` is missing in the
 *     container). It stops only the processes it spawned, never something that already held a port.
 *   - record(page): a JPEG filmstrip (default every 500 ms) plus a 100 ms in-page DOM sampler (counts, texts, attributes, a hash
 *     of each region's subtree, scroll and viewport), the app's `ns:*` performance marks, and main-frame navigations told apart
 *     into "new document" (a reload) and "same document" (history.replaceState).
 *   - finish(): analysis.mjs over the samples, then raw.json and REPORT.md in the output folder.
 */
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkTargets, eventTable, renderReport, unchangedStretches, DEFAULT_STRETCH_MS } from "./analysis.mjs";

export * from "./analysis.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..", "..", "..");
export const APP_DIR = path.join(REPO, "command-center");
export const FAKE_SCRIPT = path.join(REPO, "tools", "visual-qa", "fake-supabase.mjs");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadPlaywright() {
  const roots = [APP_DIR, "/opt/node22/lib/node_modules"];
  try {
    roots.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim());
  } catch {
    /* local only */
  }
  for (const root of roots) {
    try {
      return createRequire(path.join(root, "noop.js"))("playwright");
    } catch {
      /* next root */
    }
  }
  throw new Error("Playwright not found: install it globally (npm i -g playwright) or in command-center.");
}

export function chromiumPath() {
  try {
    return statSync("/opt/pw-browsers/chromium").isFile() ? "/opt/pw-browsers/chromium" : undefined;
  } catch {
    return undefined;
  }
}

/** True when nothing listens on `port` (on any address): a listen test, because the container has no `ss`. */
export function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port }, () => srv.close(() => resolve(true)));
  });
}

/** `preferred` if it is free, otherwise one the OS hands out. */
export async function freePort(preferred) {
  if (preferred && (await portFree(preferred))) return preferred;
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen({ port: 0 }, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * The Supabase URL a build baked into its client chunks (NEXT_PUBLIC_SUPABASE_URL is inlined at build time), so the fake is
 * started where the browser will look for it. Returns null when none is found (a build against a real project, or no build).
 */
export function bakedSupabaseUrl(appDir = APP_DIR) {
  const dir = path.join(appDir, ".next", "static", "chunks");
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith(".js")) {
        const m = /https?:\/\/(?:127\.0\.0\.1|localhost):\d{2,5}/.exec(readFileSync(p, "utf8"));
        if (m) return m[0];
      }
    }
  }
  return null;
}

async function waitHttp(url, child, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`${label} exited with code ${child.exitCode} before it answered; see its log.`);
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status > 0) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`${label} did not answer ${url} within ${timeoutMs} ms.`);
}

function spawnLogged(cmd, args, { cwd, env, log }) {
  // detached: its own process group, so stop() can end `npx` and the `next` it spawns together and nothing else.
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  const keep = (b) => {
    lines.push(String(b));
    if (lines.length > 400) lines.shift();
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  if (log) child.on("exit", () => writeFileSync(log, lines.join("")));
  return { child, lines };
}

function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const done = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* gone */
      }
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(done);
      resolve();
    });
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      clearTimeout(done);
      resolve();
    }
  });
}

/**
 * Starts the fake on the port the build expects and `next start` on a free port. `appEnv` is the server's runtime env (feature
 * switches such as NIGHTSHIFT_AI_CHAT); `fakeEnv` the fake's (FAKE_ADMIN). A fake port already in use is an error, not a silent
 * switch: the browser would keep calling the baked URL and measure whatever answers there.
 */
export async function startStack({ appDir = APP_DIR, appPort = 3600, fakeUrl = null, appEnv = {}, fakeEnv = {}, logDir = null } = {}) {
  const url = fakeUrl ?? bakedSupabaseUrl(appDir);
  if (!url) throw new Error("No Supabase URL found in the build. Build with NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:<port> (see README.md).");
  const fakePort = Number(new URL(url).port);
  if (!(await portFree(fakePort))) {
    throw new Error(`Port ${fakePort} (the build's Supabase URL) is already in use. Stop what holds it, or rebuild with another port.`);
  }
  try {
    statSync(path.join(appDir, ".next", "BUILD_ID"));
  } catch {
    throw new Error(`No build in ${appDir}/.next. Run \`next build\` first (see README.md).`);
  }
  if (logDir) mkdirSync(logDir, { recursive: true });
  const started = [];
  const stack = {
    fakeUrl: `http://127.0.0.1:${fakePort}`,
    base: null,
    async stop() {
      for (const c of started.reverse()) await stopChild(c);
    },
  };
  try {
    const fake = spawnLogged(process.execPath, [FAKE_SCRIPT], { cwd: REPO, env: { PORT: String(fakePort), ...fakeEnv }, log: logDir && path.join(logDir, "fake.log") });
    started.push(fake.child);
    await waitHttp(`${stack.fakeUrl}/auth/v1/settings`, fake.child, 15000, "fake supabase");
    const port = await freePort(appPort);
    const app = spawnLogged("npx", ["next", "start", "-p", String(port)], {
      cwd: appDir,
      // Server code may read these at runtime as well; they must name the same fake the client bundle calls. Not a key: the fake
      // accepts anything.
      env: { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: "visual-qa-not-a-key", ...appEnv },
      log: logDir && path.join(logDir, "app.log"),
    });
    started.push(app.child);
    stack.base = `http://localhost:${port}`;
    await waitHttp(`${stack.base}/`, app.child, 60000, "next start");
  } catch (e) {
    await stack.stop();
    throw e;
  }
  return stack;
}

/** Runs in the page. Kept free of closures: Playwright serialises it. */
function pageSample(cfg) {
  const hash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  };
  const counts = {};
  for (const [k, sel] of Object.entries(cfg.counts)) counts[k] = document.querySelectorAll(sel).length;
  const texts = {};
  for (const [k, sel] of Object.entries(cfg.texts)) {
    const el = document.querySelector(sel);
    texts[k] = el ? (el.value !== undefined && el.tagName === "TEXTAREA" ? el.value : el.textContent || "").trim().slice(0, 200) : null;
  }
  const attrs = {};
  for (const [k, [sel, name]] of Object.entries(cfg.attrs)) {
    const el = document.querySelector(sel);
    attrs[k] = el ? (name === "style" ? el.getAttribute("style") : el.getAttribute(name)) : null;
  }
  const regions = {};
  for (const [k, sel] of Object.entries(cfg.regions)) {
    const els = document.querySelectorAll(sel);
    regions[k] = els.length ? hash([...els].map((e) => e.outerHTML).join("\u0000")) : null;
  }
  const marks = performance
    .getEntriesByType("mark")
    .filter((m) => m.name.startsWith("ns:"))
    .map((m) => ({ name: m.name, epoch: performance.timeOrigin + m.startTime }));
  return {
    docId: window.__nsTimingDoc || null,
    url: location.pathname + location.search,
    ready: document.readyState,
    counts,
    texts,
    attrs,
    regions,
    scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
    viewport: { w: window.innerWidth, h: window.innerHeight },
    marks,
  };
}

/**
 * Attach to a page before its first navigation. `watch` = { counts, texts, attrs: {name: [selector, attribute]}, regions } of CSS
 * selectors. Returns { t, mark, start, finish }. t() is ms since the recorder was created; script marks (`mark`) are the scenario's
 * own steps and live on the same clock as the app's `ns:*` marks.
 */
export async function record(page, { out, watch = {}, sampleMs = 100, shotMs = 500, shots = true, jpegQuality = 55 } = {}) {
  mkdirSync(out, { recursive: true });
  const cfg = { counts: watch.counts || {}, texts: watch.texts || {}, attrs: watch.attrs || {}, regions: watch.regions || {} };
  const T0 = Date.now();
  const t = () => Date.now() - T0;
  const samples = [];
  const marks = [];
  const pageMarks = new Map();
  const navigations = [];
  const net = [];
  const strip = [];
  let pendingDocRequest = false;
  let running = false;
  let loops = [];

  // A fresh id per document: if it changes between samples, a new document was loaded, whatever the navigation API said.
  await page.addInitScript(() => {
    window.__nsTimingDoc = Math.random().toString(36).slice(2);
  });
  page.on("request", (r) => {
    try {
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) pendingDocRequest = true;
    } catch {
      /* a service-worker request has no frame */
    }
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/") || r.resourceType() === "document") net.push({ t: t(), ev: "req", m: r.method(), p: u.pathname + u.search });
  });
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith("/api/") || r.request().resourceType() === "document") net.push({ t: t(), ev: "res", s: r.status(), p: u.pathname + u.search });
  });
  page.on("framenavigated", (f) => {
    if (f !== page.mainFrame()) return;
    // Playwright reports same-document (history API) navigations here too; only one preceded by a main-frame document request
    // is a new document.
    navigations.push({ t: t(), url: f.url().replace(/^https?:\/\/[^/]+/, ""), document: pendingDocRequest });
    pendingDocRequest = false;
  });

  const sampleLoop = async () => {
    while (running) {
      const at = t();
      try {
        const s = await page.evaluate(pageSample, cfg);
        for (const m of s.marks) {
          const key = `${m.name}@${Math.round(m.epoch)}`;
          if (!pageMarks.has(key)) pageMarks.set(key, { t: Math.round(m.epoch - T0), name: m.name, source: "page" });
        }
        delete s.marks;
        samples.push({ t: at, ...s });
      } catch (e) {
        samples.push({ t: at, error: String(e.message).slice(0, 80) });
      }
      await sleep(Math.max(0, sampleMs - (t() - at)));
    }
  };
  const shotLoop = async () => {
    let n = 0;
    while (running && shots) {
      const at = t();
      const f = path.join(out, `f${String(n++).padStart(4, "0")}_${String(at).padStart(6, "0")}ms.jpg`);
      try {
        // caret: "initial" — the default ("hide") makes Playwright touch the DOM on every shot, which the sampler then read as the
        // page changing every 500 ms and hid a board frozen for the whole session (measured at L=2: a change at every shot with it, 16 changes in the whole run without).
        await page.screenshot({ path: f, type: "jpeg", quality: jpegQuality, caret: "initial" });
        strip.push({ t: at, f });
      } catch {
        /* between documents */
      }
      await sleep(Math.max(0, shotMs - (t() - at)));
    }
  };

  return {
    t,
    mark(name, extra = {}) {
      marks.push({ t: t(), name, source: "script", ...extra });
    },
    start() {
      running = true;
      loops = [sampleLoop(), shotLoop()];
    },
    async stop() {
      running = false;
      await Promise.all(loops);
    },
    data() {
      // A new document seen by the sampler but missed by the navigation listener still counts (and vice versa it is not doubled).
      const docs = [];
      let last = null;
      for (const s of samples) {
        if (s.error || !s.docId) continue;
        if (last !== null && s.docId !== last) docs.push(s.t);
        last = s.docId;
      }
      const allMarks = [...marks, ...pageMarks.values()].sort((a, b) => a.t - b.t);
      return { samples, marks: allMarks, navigations, docChanges: docs, net, strip };
    },
  };
}

/**
 * Analyse and write raw.json and REPORT.md. `windows` are the intervals in which work runs; `defs` the DOM events for the table;
 * `stretchRegions` the region names checked against the 3 s target (null = the whole sampled screen).
 */
export function finish({ out, title, meta = {}, rec, windows, defs, createAt = null, stretchRegions = [null], thresholdMs = DEFAULT_STRETCH_MS, notes = [] }) {
  const d = rec.data();
  const table = eventTable({ samples: d.samples, marks: d.marks, navigations: d.navigations, defs });
  const stretches = stretchRegions
    .flatMap((only) => unchangedStretches(d.samples, windows, { thresholdMs, only }))
    .sort((a, b) => b.ms - a.ms);
  const checks = checkTargets({ windows, table, samples: d.samples, navigations: d.navigations, createAt, stretchRegions });
  const pageMarkCount = d.marks.filter((m) => m.source === "page").length;
  const allNotes = [
    pageMarkCount ? `${pageMarkCount} \`ns:*\` performance marks collected from the app.` : "The app emitted no `ns:*` performance marks; events come from DOM selectors only.",
    `Document changes seen by the sampler: ${d.docChanges.length}; main-frame navigations: ${d.navigations.length} (${d.navigations.filter((n) => n.document).length} new documents).`,
    ...notes,
  ];
  writeFileSync(path.join(out, "raw.json"), JSON.stringify({ meta, windows, defs: defs.map((x) => ({ ...x, match: x.match ? String(x.match) : undefined })), table, stretches, checks, ...d }, null, 1));
  const report = renderReport({ title, meta, table, windows, stretches, checks, strip: d.strip.map((s) => ({ ...s, f: path.basename(s.f) })), notes: allNotes });
  writeFileSync(path.join(out, "REPORT.md"), report);
  return { table, stretches, checks, report };
}
