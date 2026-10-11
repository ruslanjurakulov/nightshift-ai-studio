#!/usr/bin/env node
/**
 * Screenshots for the account and sign-in work (docs/design/account-auth/):
 * /login, /forgot-password, /reset-password, /signup in its username states
 * (the rule, available, taken) and Settings → Account and security, in
 * Chromium, at 1440 and 390, light and dark, English plus Russian and Uzbek.
 * Also runs axe on every page and reports serious or worse violations and
 * horizontal overflow, so "no overflow in ru/uz" is measured, not assumed.
 *
 * Needs the app built against tools/visual-qa/fake-supabase.mjs and running
 * (see that file's header), and Pillow for the WebP conversion:
 *
 *   node tools/visual-qa/fake-supabase.mjs &
 *   cd command-center && NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54399 \
 *     NEXT_PUBLIC_SUPABASE_ANON_KEY=visual-qa-not-a-key npx next build && npx next start -p 3417 &
 *   node tools/visual-qa/account-auth.mjs --base http://localhost:3417 --out docs/design/account-auth
 *
 * Screenshots only: nothing is sent anywhere, no e-mail is sent, the fake
 * refuses every write. Not part of the product; ships in no bundle.
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionCookie } from "./fake-supabase.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const APP = path.join(REPO, "command-center");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BASE = String(arg("base", "http://localhost:3417")).replace(/\/$/, "");
const OUT = path.resolve(String(arg("out", path.join(REPO, "docs", "design", "account-auth"))));
const QUALITY = String(arg("quality", "62"));
const ONLY = arg("only", null);

function loadPlaywright() {
  const roots = [APP, REPO];
  try {
    roots.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim());
  } catch {
    /* no npm on PATH: the local roots only */
  }
  for (const root of roots) {
    try {
      return createRequire(path.join(root, "noop.js"))("playwright");
    } catch {
      /* next root */
    }
  }
  throw new Error("Playwright not found (command-center/node_modules or the global npm root).");
}
const { chromium } = loadPlaywright();
const AXE_SRC = (() => {
  const p = path.join(APP, "node_modules", "axe-core", "axe.min.js");
  return existsSync(p) ? readFileSync(p, "utf8") : null;
})();

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

const FAKE_USER_ID = "00000000-0000-4000-8000-0000000000aa";
const typeInto = (label) => async (page, text) => {
  await page.getByLabel(new RegExp(`^${label}`)).first().fill(text);
  await page.waitForTimeout(900);
};
const HANDLE_LABEL = { en: "Username", ru: "Имя пользователя", uz: "Foydalanuvchi nomi" };
const EMAIL_LABEL = { en: "Email", ru: "Эл. почта", uz: "Email" };

// id, path, session state (null = signed out), extra setup, full page?
const SCENES = [
  { id: "login", path: "/login" },
  { id: "forgot", path: "/forgot-password" },
  { id: "forgot-expired", path: "/forgot-password?s=expired", locales: ["en"], themes: ["light"], widths: [1440, 390] },
  {
    id: "forgot-sent",
    path: "/forgot-password",
    locales: ["en"],
    themes: ["light"],
    widths: [390],
    act: async (page, loc) => {
      await page.getByLabel(new RegExp(`^${EMAIL_LABEL[loc]}`)).first().fill("ana@example.com");
      await page.locator("form button[type=submit]").click();
      await page.waitForTimeout(800);
    },
  },
  { id: "reset", path: "/reset-password", recovery: true },
  { id: "signup-rule", path: "/signup", act: (page, loc) => typeInto(HANDLE_LABEL[loc])(page, "a..b"), locales: ["en"] },
  { id: "signup-available", path: "/signup", act: (page, loc) => typeInto(HANDLE_LABEL[loc])(page, "free.name") },
  { id: "signup-taken", path: "/signup", act: (page, loc) => typeInto(HANDLE_LABEL[loc])(page, "taken.name"), locales: ["en"] },
  { id: "settings-pick", path: "/night-owl/organization", state: "acct", full: true, section: true },
  { id: "settings-handle", path: "/night-owl/organization", state: "acct_handle", full: true, section: true, locales: ["en"] },
  { id: "settings-cooldown", path: "/night-owl/organization", state: "acct_cool", full: true, section: true, locales: ["en"], themes: ["light"], widths: [1440] },
];

const LOCALES = ["en", "ru", "uz"];
const WIDTHS = [1440, 390];
const THEMES = ["light", "dark"];
// Russian and Uzbek are checked for overflow at both widths but photographed in one theme each.
const keep = (loc, width, theme) => loc === "en" || (width === 1440 ? theme === "light" : theme === "dark");

mkdirSync(OUT, { recursive: true });
const tmp = path.join(OUT, ".png-tmp");
mkdirSync(tmp, { recursive: true });

const browser = await chromium.launch({ executablePath: chromiumPath() });
const report = [];
let shots = 0;
for (const scene of SCENES) {
  if (ONLY && !String(ONLY).split(",").includes(scene.id)) continue;
  for (const loc of scene.locales ?? LOCALES) {
    for (const width of scene.widths ?? WIDTHS) {
      for (const theme of scene.themes ?? THEMES) {
        const phone = width < 600;
        const context = await browser.newContext({
          viewport: { width, height: phone ? 844 : 900 },
          colorScheme: theme,
          reducedMotion: "reduce",
          hasTouch: phone,
          isMobile: phone,
        });
        await context.addCookies([{ name: "chronos_locale", value: loc, url: BASE }]);
        if (scene.state || scene.recovery) {
          const c = sessionCookie(undefined, scene.state ?? "");
          await context.addCookies([{ ...c, url: BASE }]);
        }
        if (scene.recovery) {
          // The marker /auth/callback leaves for /reset-password (lib/recovery.ts): this account, now.
          await context.addCookies([{ name: "ns_recovery", value: `${FAKE_USER_ID}.${Math.floor(Date.now() / 1000)}`, url: BASE }]);
        }
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 160)));
        const name = `${scene.id}_${loc}_${width}_${theme}`;
        const row = { name };
        try {
          const resp = await page.goto(BASE + scene.path, { waitUntil: "load", timeout: 45000 });
          row.status = resp?.status();
          await page.waitForTimeout(900);
          if (scene.act) await scene.act(page, loc);
          if (scene.section) {
            await page.locator("#account-security-title").scrollIntoViewIfNeeded().catch(() => undefined);
          }
          row.overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          // Touch targets under 44px and text fields under 16px (the same rules as visual-qa.mjs), phone width only.
          if (phone) {
            row.small = await page.evaluate(() => {
              const out = [];
              for (const el of document.querySelectorAll("a[href], button, [role=button], select, input:not([type=hidden])")) {
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || el.closest("[hidden], [aria-hidden=true]")) continue;
                if (r.height >= 43.5 && r.width >= 43.5) continue;
                if (el.tagName === "A" && el.closest("p, li") && cs.display === "inline") continue;
                out.push(`${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}"`);
              }
              return out.slice(0, 8);
            });
          }
          if (AXE_SRC) {
            await page.addScriptTag({ content: AXE_SRC });
            const v = await page.evaluate(async () => {
              const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
              return r.violations.filter((x) => x.impact === "serious" || x.impact === "critical").map((x) => `${x.id}x${x.nodes.length}`);
            });
            row.axe = v;
          }
          if (keep(loc, width, theme)) {
            const png = path.join(tmp, `${name}.png`);
            if (scene.section) {
              // Settings: the page from the top to the end of the new section, one picture.
              await page.screenshot({ path: png, fullPage: true });
            } else {
              await page.screenshot({ path: png, fullPage: !!scene.full });
            }
            shots += 1;
          }
        } catch (e) {
          row.error = String(e.message || e).slice(0, 200);
        }
        row.errors = errors;
        report.push(row);
        process.stdout.write(`${name}: ${row.error ? "ERROR " + row.error : `status=${row.status} overflow=${row.overflow} axe=${(row.axe || []).join(",") || "0"}`}\n`);
        await context.close();
      }
    }
  }
}
await browser.close();

// PNG -> WebP (Pillow), then drop the PNGs.
execFileSync(
  "python3",
  [
    "-I",
    "-c",
    `
import sys, os
from PIL import Image
src, dst, q = sys.argv[1], sys.argv[2], int(sys.argv[3])
for f in sorted(os.listdir(src)):
    if f.endswith(".png"):
        Image.open(os.path.join(src, f)).convert("RGB").save(os.path.join(dst, f[:-4] + ".webp"), "WEBP", quality=q, method=6)
`,
    tmp,
    OUT,
    QUALITY,
  ],
  { stdio: "inherit" },
);
rmSync(tmp, { recursive: true, force: true });
const bad = report.filter((r) => r.error || r.overflow > 0 || (r.axe || []).length || (r.errors || []).length || (r.small || []).length);
process.stdout.write(`\n${shots} pictures in ${OUT}; ${bad.length} run(s) with an error, overflow or serious axe finding\n`);
for (const r of bad) process.stdout.write(`  ${r.name}: ${JSON.stringify({ error: r.error, overflow: r.overflow, axe: r.axe, errors: r.errors, small: r.small })}\n`);
