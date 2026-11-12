#!/usr/bin/env node
/**
 * Phone-width smoke of the editor's "reuse a look" batch (multi-select, sync lock, paste attributes) in real
 * Chromium: the TimelineEditor component on a fixture project (./main.tsx), served by Vite from command-center's own
 * node_modules, every request answered "offline" (nothing reaches a server). At 320, 390 and 768 css px and a 1440
 * desktop it checks that a long press turns select mode on and a tap adds, a marquee drag selects (desktop), a lane
 * lock toggles, the paste-attributes dialog fits the screen and pastes, and the page never scrolls sideways or logs
 * an error. Exits 1 when a check fails. Pictures go to --out when given.
 *
 *   node tools/visual-qa/editor-reuse/smoke.mjs [--out /tmp/shots]
 *
 * Needs Playwright with its Chromium already installed (it is not installed here).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..", "..");
const CC = path.join(REPO, "command-center");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};
const OUT = arg("out");

function load(name) {
  const roots = [CC, REPO];
  try {
    roots.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim());
  } catch {
    /* local roots only */
  }
  for (const root of roots) {
    try {
      return createRequire(path.join(root, "noop.js")).resolve(name);
    } catch {
      /* next */
    }
  }
  throw new Error(`${name} is not installed`);
}

const { createServer } = await import(pathToFileURL(load("vite")).href);
const { chromium } = createRequire(import.meta.url)(load("playwright"));
const AXE = readFileSync(load("axe-core/axe.min.js"), "utf8");

const server = await createServer({
  configFile: false,
  root: HERE,
  cacheDir: path.join(CC, "node_modules", ".vite-editor-reuse"),
  logLevel: "error",
  publicDir: path.join(CC, "public"),
  resolve: {
    alias: [
      { find: /^next\/link$/, replacement: path.join(HERE, "stubs/link.tsx") },
      { find: /^next\/navigation$/, replacement: path.join(HERE, "stubs/navigation.ts") },
      { find: /^@\//, replacement: CC + "/" },
      // this folder has no node_modules of its own: React is command-center's
      { find: /^react$/, replacement: path.join(CC, "node_modules", "react") },
      { find: /^react\/jsx-runtime$/, replacement: path.join(CC, "node_modules", "react", "jsx-runtime.js") },
      { find: /^react\/jsx-dev-runtime$/, replacement: path.join(CC, "node_modules", "react", "jsx-dev-runtime.js") },
      { find: /^react-dom\/client$/, replacement: path.join(CC, "node_modules", "react-dom", "client.js") },
    ],
  },
  define: { "process.env": "{}" },
  esbuild: { jsx: "automatic" },
  css: { postcss: CC },
  server: { port: 0, host: "127.0.0.1", fs: { allow: [CC, HERE] } },
});
await server.listen();
const BASE = server.resolvedUrls.local[0];

const failures = [];
const expect = (ok, what) => {
  if (!ok) failures.push(what);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
};

const browser = await chromium.launch();
try {
  for (const [width, phone, tag] of [
    [320, true, "phone320"],
    [390, true, "phone390"],
    [768, false, "tablet768"],
    [1440, false, "desktop"],
  ]) {
    const ctx = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1 });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator(".ns-lanes-root").first().waitFor();
    const item = (kind, id) => page.locator(`[data-item-kind="${kind}"][data-item-id="${id}"]`);
    const count = () => page.locator('[data-testid="selection-count"]').textContent().catch(() => null);

    if (phone) {
      // a long press (half a second, still) on clip 2: select mode with clip 2 alone; a tap on a text adds it
      await item("clip", "c2").scrollIntoViewIfNeeded();
      const b = await item("clip", "c2").boundingBox();
      await page.evaluate(async ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        const o = { bubbles: true, pointerType: "touch", clientX: x, clientY: y, pointerId: 3, isPrimary: true };
        el.dispatchEvent(new PointerEvent("pointerdown", o));
        await new Promise((r) => setTimeout(r, 650));
        el.dispatchEvent(new PointerEvent("pointerup", o));
      }, [b.x + 6, b.y + 6]);
      expect((await page.getByRole("button", { name: "Done" }).getAttribute("aria-pressed")) === "true", `${tag}: a long press turns select mode on`);
      await item("text", "x2").tap();
      expect((await count()) === "2 items selected", `${tag}: a tap in select mode adds (2 selected)`);
      await page.getByRole("button", { name: "Done" }).tap();
    } else {
      // a marquee from the empty space under clip 1's lane, across the overlay and the late text
      const lanes = page.locator(".ns-lanes-root").first();
      await lanes.scrollIntoViewIfNeeded();
      const b = await lanes.boundingBox();
      await page.mouse.move(b.x + b.width * 0.5, b.y + b.height - 3);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width * 0.9, b.y + 30, { steps: 6 });
      expect(await page.locator('[data-testid="marquee"]').isVisible(), `${tag}: the marquee is drawn while dragging`);
      await page.mouse.up();
      const n = Number(((await count()) ?? "0").split(" ")[0]);
      expect(n >= 3, `${tag}: the marquee selected what it touched (${n})`);
      await item("clip", "c1").click();
      expect((await count()) === null, `${tag}: a plain click selects one again`);
    }

    // sync lock: the text lane locks and says so
    const lock = page.getByRole("button", { name: "Lock the Texts lane" });
    await lock.scrollIntoViewIfNeeded();
    await lock.click();
    expect((await lock.getAttribute("aria-pressed")) === "true", `${tag}: the text lane locks`);
    const lb = await lock.boundingBox();
    expect(lb.height >= (phone ? 43.5 : 20), `${tag}: the lock is a ${phone ? "44 px" : "real"} target (${Math.round(lb.height)})`);
    if (OUT) await page.screenshot({ path: path.join(OUT, `${tag}-sync-lock.png`) });

    // paste attributes: copy clip 1's look, select clips 2 and 3, paste
    await item("clip", "c1").click();
    await page.getByRole("button", { name: "Copy look" }).click();
    await item("clip", "c2").click();
    await item("clip", "c3").click({ modifiers: ["Shift"] });
    await page.locator('[data-testid="selection-bar"]').getByRole("button", { name: "Paste look…" }).click();
    const dlg = page.getByRole("dialog", { name: "Paste attributes" });
    await dlg.waitFor();
    const db = await dlg.boundingBox();
    expect(db.x >= 0 && db.x + db.width <= width + 0.5, `${tag}: the dialog fits the screen's width`);
    if (OUT) await page.screenshot({ path: path.join(OUT, `${tag}-paste-attributes.png`) });
    // no serious or critical accessibility problem with the dialog open (axe-core, as the other visual checks use it)
    await page.evaluate(AXE);
    const bad = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      const r = await axe.run(document, { resultTypes: ["violations"] });
      return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`);
    });
    expect(bad.length === 0, `${tag}: no serious accessibility problem${bad.length ? `: ${bad.slice(0, 3).join(" | ")}` : ""}`);
    await dlg.getByRole("button", { name: "Paste on 2 clips" }).click();
    const said = await page.locator('[data-testid="selection-status"]').textContent();
    expect(said === "Pasted on 2 clips.", `${tag}: the look is pasted on 2 clips (${said})`);
    expect(!(await dlg.isVisible()), `${tag}: the dialog closes`);

    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways <= 0, `${tag}: no sideways scroll (${sideways} px)`);
    expect(errors.length === 0, `${tag}: no page errors${errors.length ? `: ${errors[0]}` : ""}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (failures.length) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("all checks passed");
