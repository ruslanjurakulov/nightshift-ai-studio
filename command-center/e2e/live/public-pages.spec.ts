import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Read-only smoke over the LIVE public site. Nothing here may spend, publish, sign up or submit a
// form: the suite only navigates (GET) and reads the DOM. As a belt-and-braces guard every
// non-GET request to the site is aborted before it leaves the browser, so even a page that fires
// a mutation on load cannot create anything on the live system.

const BASE_URL = (process.env.BASE_URL || "https://nightshift-ai.studio").replace(/\/+$/, "");
const LOCALE_COOKIE = "chronos_locale"; // lib/i18n/core.ts

const PAGES = [
  { name: "home", path: "/", status: 200 },
  { name: "pricing", path: "/pricing", status: 200 },
  { name: "models", path: "/models", status: 200 },
  { name: "login", path: "/login", status: 200 },
  { name: "data-deletion", path: "/data-deletion", status: 200 },
  { name: "privacy", path: "/privacy", status: 200 },
  { name: "terms", path: "/terms", status: 200 },
  { name: "404", path: "/this-page-does-not-exist-e2e-probe", status: 404 },
] as const;

const LANGS = ["en", "uz"] as const;
type Lang = (typeof LANGS)[number];

const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
] as const;

const ARTIFACTS = path.join(__dirname, "..", "artifacts");

async function setLang(context: BrowserContext, lang: Lang) {
  await context.clearCookies();
  await context.addCookies([{ name: LOCALE_COOKIE, value: lang, url: BASE_URL }]);
}

type Visit = { status: number; consoleErrors: string[]; failed: string[]; blockedWrites: string[] };

async function visit(page: Page, p: string): Promise<Visit> {
  const origin = new URL(BASE_URL).origin;
  const url = BASE_URL + p;
  const consoleErrors: string[] = [];
  const failed: string[] = [];
  const blockedWrites: string[] = [];

  await page.route("**/*", (route) => {
    const req = route.request();
    if (req.url().startsWith(origin) && !["GET", "HEAD", "OPTIONS"].includes(req.method())) {
      blockedWrites.push(`${req.method()} ${req.url()}`);
      return route.abort();
    }
    return route.continue();
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // A deliberate 404 makes the browser log "Failed to load resource" for the document itself.
    if (m.location().url === url && /404/.test(m.text())) return;
    consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    if (r.url().startsWith(origin) && r.failure()?.errorText !== "net::ERR_ABORTED") {
      failed.push(`${r.url()} ${r.failure()?.errorText}`);
    }
  });
  page.on("response", (r) => {
    if (r.url().startsWith(origin) && r.status() >= 400 && r.url() !== url) {
      failed.push(`${r.status()} ${r.url()}`);
    }
  });

  const res = await page.goto(url, { waitUntil: "networkidle" });
  return { status: res?.status() ?? 0, consoleErrors, failed, blockedWrites };
}

async function heading(page: Page): Promise<string> {
  const h = page.locator("h1").first();
  await h.waitFor({ state: "visible", timeout: 15_000 });
  return (await h.innerText()).trim();
}

for (const pg of PAGES) {
  for (const vp of VIEWPORTS) {
    test.describe(`${pg.name} @ ${vp.name}px`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });

      for (const lang of LANGS) {
        test(`[${pg.name}] [${vp.name}px] [${lang}] renders cleanly`, async ({ page, context }) => {
          await setLang(context, lang);
          const v = await visit(page, pg.path);

          fs.mkdirSync(ARTIFACTS, { recursive: true });
          await page.screenshot({
            path: path.join(ARTIFACTS, `${pg.name}-${lang}-${vp.name}.png`),
            fullPage: true,
          });

          expect(v.status, "HTTP status").toBe(pg.status);
          expect(v.consoleErrors, "console errors").toEqual([]);
          expect(v.failed, "failed same-origin requests").toEqual([]);

          if (vp.width <= 390) {
            const m = await page.evaluate(() => ({
              sw: (document.scrollingElement ?? document.documentElement).scrollWidth,
              iw: window.innerWidth,
            }));
            expect(m.sw, "horizontal scroll at 390px").toBeLessThanOrEqual(m.iw + 1);
          }

          const imgs = await page.evaluate(() =>
            Array.from(document.images)
              .filter((i) => i.getAttribute("alt") === null && i.closest("[aria-hidden='true']") === null && i.getAttribute("aria-hidden") !== "true" && i.getAttribute("role") !== "presentation")
              .map((i) => i.currentSrc || i.src),
          );
          expect(imgs, "images without alt (and not aria-hidden)").toEqual([]);

          if (lang === "uz") {
            const text = await page.evaluate(() => document.body.innerText);
            const bad = text.match(/\p{L}'\p{L}/gu) ?? [];
            expect(bad, "ASCII apostrophe inside Uzbek words (use U+02BB / U+02BC)").toEqual([]);
          }

          if (vp.width >= 1440) {
            const cta = await page.evaluate(() => {
              const root = document.querySelector("main") ?? document.body;
              return Array.from(root.querySelectorAll("a[href], button"))
                .map((e) => {
                  const r = e.getBoundingClientRect();
                  const s = getComputedStyle(e);
                  const visible = r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
                  return visible && r.top >= 0 && r.top < window.innerHeight ? (e.textContent || "").trim() : null;
                })
                .filter((t): t is string => t !== null && t.length > 0).length;
            });
            expect(cta, "visible link/button above the fold at 1440px").toBeGreaterThan(0);
          }

          expect(v.blockedWrites, "page tried to write on load (aborted by the suite)").toEqual([]);
        });
      }

      test(`[${pg.name}] [${vp.name}px] language switch changes the heading`, async ({ page, context }) => {
        await setLang(context, "en");
        await visit(page, pg.path);
        const en = await heading(page);
        await setLang(context, "uz");
        await visit(page, pg.path);
        const uz = await heading(page);
        expect(uz, `en heading "${en}" must differ in uz`).not.toBe(en);
      });
    });
  }
}

// "/" scrolled sideways at 360 px in ru and uz (S5's Pixel audit, 2026-11-22): the prompt ticker's meta row was a nowrap flex row
// with min-width auto, so the badge and "Model Runway Gen-4.5" (334 px) overflowed its 294 px box. The landing no longer draws the
// ticker, and its row now wraps; this keeps the narrowest phone we support from scrolling sideways in any language.
for (const lang of ["en", "ru", "uz"] as const) {
  test(`[home] [360px] [${lang}] nothing scrolls sideways`, async ({ page, context }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    await context.clearCookies();
    await context.addCookies([{ name: LOCALE_COOKIE, value: lang, url: BASE_URL }]);
    const v = await visit(page, "/");
    expect(v.status, "HTTP status").toBe(200);
    const sw = await page.evaluate(() => (document.scrollingElement ?? document.documentElement).scrollWidth);
    expect(sw, `page width at 360px (${lang})`).toBeLessThanOrEqual(360);
  });
}
