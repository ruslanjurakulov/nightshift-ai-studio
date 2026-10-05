// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { McpPage } from "@/components/docs/McpPage";
import { BrandLogo, BrandSprite } from "@/components/docs/BrandLogo";
import { BRAND_ART } from "@/lib/dev/brand-logos-art";
import { ANTHROPIC_MARKS_APPROVED, BRAND_LOGOS, OWNER_ACCEPTED_MARKS_SHOWN, brandLogo, logoShown, shownSymbols } from "@/lib/dev/brand-logos";
import { MCP_CLIENTS } from "@/lib/dev/mcp-clients";
import { devDictionaries } from "@/lib/i18n/dev";
import type { Locale } from "@/lib/i18n";

/**
 * The third-party logos on /mcp (lib/dev/brand-logos.ts, docs/design/BRAND_LOGOS.md).
 * What these tests hold: every client has a register entry or a documented
 * fallback; every shown mark is the vendor's own drawing, byte for byte in its
 * paths; the markup asks no other origin for anything and holds no script; the
 * marks the owners' rules do not (yet) allow are not on the page.
 */

const ROOT = join(__dirname, "..");
const LOCALES: Locale[] = ["en", "ru", "uz"];

/** The file in brand/third-party each sprite symbol is made from (tools/brand/build_brand_logos.mjs FILES). */
const SOURCE: Record<string, string> = {
  "cursor-light": "cursor/CUBE_2D_LIGHT.svg",
  "cursor-dark": "cursor/CUBE_2D_DARK.svg",
  "windsurf-light": "windsurf/windsurf-black-symbol.svg",
  "windsurf-dark": "windsurf/windsurf-white-symbol.svg",
  "vscode-any": "vscode/vscode.svg",
  "zed-light": "zed/zed-logomark-black.svg",
  "zed-dark": "zed/zed-logomark-white.svg",
  "warp-light": "warp/Warp-Glyph-Black.svg",
  "warp-dark": "warp/Warp-Glyph-White.svg",
  "cline-light": "cline/BOT_LIGHT.svg",
  "cline-dark": "cline/BOT_DARK.svg",
  "openai-light": "openai/OAI_OpenAI-Blossom_Black.svg",
  "openai-dark": "openai/OAI_OpenAI-Blossom_White.svg",
  "openclaw-any": "openclaw/favicon.svg",
  "roo-any": "roo/icon.svg",
  "claude-any": "anthropic/ClaudeIcon-Rounded.svg",
  "claude-spark-any": "anthropic/ClaudeSpark-Clay.svg",
};

/**
 * One-colour versions: the vendor's drawing with only its fill swapped for the text colour (the way a
 * monochrome press-kit variant differs from the colour one). symbol -> [file, the colour it replaces].
 */
const MONO: Record<string, [string, string]> = {
  "claude-spark-mono": ["anthropic/ClaudeSpark-Clay.svg", "#D97757"],
};

/** The marks a vendor offers only as a picture: the file in brand/third-party each is made from. */
const RASTER: Record<string, string> = {
  "hermes-any": "hermes/icon.png",
  "gemini-any": "gemini-cli/icon.png",
};

const page = (locale: Locale = "en") =>
  renderToStaticMarkup(
    <McpPage dev={devDictionaries[locale]} origin="https://example.test" labels={{ table: "Table", code: "Code" }} showCli={false} oauthLive={false} />,
  );

describe("the register (lib/dev/brand-logos.ts)", () => {
  it("has an entry for every client on /mcp, and no entry for a client that is not there", () => {
    expect(BRAND_LOGOS.map((b) => b.id).sort()).toEqual(MCP_CLIENTS.map((c) => c.id).sort());
  });

  it.each(BRAND_LOGOS.map((b) => [b.id, b] as const))("%s: names its vendor, its asset source, its rules page, what they allow and when it was read", (_, b) => {
    for (const field of [b.vendor, b.source, b.guidelines, b.allowed, b.fetched]) expect(field.trim().length).toBeGreaterThan(0);
    expect(b.fetched).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (b.id !== "other") {
      expect(b.source).toMatch(/https?:\/\//);
      expect(b.guidelines).toMatch(/https?:\/\//);
    }
  });

  it.each(BRAND_LOGOS.filter((b) => b.status !== "official").map((b) => [b.id, b] as const))("%s: a mark shown without its vendor's permission, or not shown, says why", (_, b) => {
    expect(b.reason?.trim().length ?? 0).toBeGreaterThan(20);
  });

  it.each(BRAND_LOGOS.filter((b) => b.status === "owner-accepted").map((b) => [b.id, b] as const))("%s: records that the site owner accepted the risk and that no vendor permission was obtained", (_, b) => {
    expect(b.reason).toMatch(/without .*(approval|permission)/i);
    expect(b.reason).toContain("2026-10-03");
  });

  it("an official or owner-accepted mark has a drawing for each theme it needs, all from the sprite sheet", () => {
    for (const b of BRAND_LOGOS.filter((x) => x.status !== "fallback")) {
      expect(b.symbols, b.id).toBeTruthy();
      const s = b.symbols!;
      for (const key of "any" in s ? [s.any] : [s.light, s.dark]) expect(BRAND_ART[key], `${b.id}: ${key}`).toBeTruthy();
    }
  });

  it("the gate is on: the owner accepted the trademark risk on 2026-10-03, and every vendor's mark is shown", () => {
    expect(ANTHROPIC_MARKS_APPROVED).toBe(true);
    expect(OWNER_ACCEPTED_MARKS_SHOWN).toBe(true);
    for (const b of BRAND_LOGOS.filter((x) => x.id !== "other")) expect(logoShown(b), b.id).toBe(true);
    for (const id of ["claude", "claude-code", "claude-desktop", "gemini-cli", "hermes", "codex", "vscode", "roo-code", "openclaw", "chatgpt"]) expect(logoShown(brandLogo(id)), id).toBe(true);
  });

  it("taking them down is one line: with the gate off the owner-accepted marks go and the officially allowed ones stay", () => {
    for (const b of BRAND_LOGOS.filter((x) => x.status === "owner-accepted")) expect(logoShown(b, false), b.id).toBe(false);
    for (const b of BRAND_LOGOS.filter((x) => x.status === "official")) expect(logoShown(b, false), b.id).toBe(true);
  });

  it("only \"Other\" (any client) has no mark: it is not a product", () => {
    expect(BRAND_LOGOS.filter((b) => b.status === "fallback").map((b) => b.id)).toEqual(["other"]);
  });
});

describe("the marks are the vendors' own drawings", () => {
  it.each(Object.entries(MONO))("%s: the same shape as the vendor's colour mark, only the fill is the text colour", (symbol, [file, colour]) => {
    const original = readFileSync(join(ROOT, "brand", "third-party", file), "utf8");
    const art = BRAND_ART[symbol];
    const paths = [...art.markup.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const d of paths) expect(original).toContain(`d="${d}"`);
    expect(art.markup).toContain('fill="currentColor"');
    expect(art.markup).not.toMatch(/#[0-9a-f]{3,6}/i);
    // The vendor's file has that one colour as the path's fill, and nothing else differs.
    expect(original.toLowerCase()).toContain(`fill="${colour.toLowerCase()}"`);
    expect(art.markup.replace('fill="currentColor"', `fill="${colour}"`)).toBe(BRAND_ART["claude-spark-any"].markup);
    expect(art.viewBox).toBe(BRAND_ART["claude-spark-any"].viewBox);
  });

  it.each(Object.entries(SOURCE))("%s: every path in the sprite is, character for character, a path in the vendor's file", (symbol, file) => {
    const original = readFileSync(join(ROOT, "brand", "third-party", file), "utf8");
    const art = BRAND_ART[symbol];
    expect(art, symbol).toBeTruthy();
    const paths = [...art.markup.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const d of paths) expect(original, `${symbol}: ${d.slice(0, 40)}`).toContain(`d="${d}"`);
  });

  it.each(Object.entries(SOURCE))("%s: every element and attribute value (fill, opacity, gradient stops, filters, masks) equals the vendor's, bar the id prefix and a <style> class turned into fill", (symbol, file) => {
    const original = readFileSync(join(ROOT, "brand", "third-party", file), "utf8");
    const parse = (xml: string) => new DOMParser().parseFromString(xml, "image/svg+xml");
    const unprefix = (v: string) => v.split(`nl-${symbol}-`).join("");
    const skip = ["svg", "style", "defs", "title", "symbol"];
    const flat = (doc: Document, fromSprite: boolean, classFill: Record<string, string>) =>
      [...doc.querySelectorAll("*")]
        .filter((e) => !skip.includes(e.localName))
        .map((e) => {
          const attrs: Record<string, string> = {};
          for (const a of [...e.attributes]) {
            if (a.name === "class" || a.name.startsWith("xmlns") || a.name === "data-name") continue;
            attrs[a.name] = fromSprite ? unprefix(a.value) : a.value;
          }
          const cls = e.getAttribute("class");
          if (cls && classFill[cls]) attrs.fill = classFill[cls];
          return { tag: e.localName, attrs };
        });
    const src = parse(original);
    const css = [...src.querySelectorAll("style")].map((s) => s.textContent ?? "").join("\n");
    const classFill: Record<string, string> = {};
    for (const m of css.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
      const f = /fill\s*:\s*([^;}\s]+)/.exec(m[2]);
      if (f) classFill[m[1]] = f[1];
    }
    const want = flat(src, false, classFill);
    const got = flat(parse(`<svg xmlns="http://www.w3.org/2000/svg">${BRAND_ART[symbol].markup}</svg>`), true, {});
    expect(want.length).toBeGreaterThan(0);
    expect(got).toEqual(want);
  });

  it("no page fades or blurs a vendor's mark (owners: exactly as provided, no effects); the hero's old tile row, which had the blur rules, is gone", () => {
    const css = readFileSync(join(ROOT, "components", "site", "site.css"), "utf8");
    expect(css).not.toMatch(/\.st-tile\b/);
    for (const rule of css.matchAll(/([^{}]*\.st-(?:logo|pill-glyph)[^{}]*)\{([^}]*)\}/g)) expect(rule[2], rule[1].trim()).not.toMatch(/blur\(|opacity:\s*0?\.\d/);
  });

  it.each(Object.entries(RASTER))("%s: a picture the vendor offers only as a picture is embedded, not fetched (a data: image, no other address)", (symbol, file) => {
    const art = BRAND_ART[symbol];
    const m = /^<image href="(data:image\/(png|webp);base64,[A-Za-z0-9+/=]+)" width="(\d+)" height="(\d+)"\/>$/.exec(art.markup);
    expect(m, symbol).toBeTruthy();
    const original = readFileSync(join(ROOT, "brand", "third-party", file));
    expect(original.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    if (symbol === "hermes-any") {
      // The vendor's 48 px PNG, byte for byte.
      expect(m![2]).toBe("png");
      expect(m![1].split(",")[1]).toBe(original.toString("base64"));
    } else {
      // The vendor's large PNG, scaled down and re-encoded as WebP: the same picture, a smaller file.
      expect(m![2]).toBe("webp");
      expect(Buffer.from(m![1].split(",")[1], "base64").subarray(8, 12).toString()).toBe("WEBP");
      expect(art.viewBox).toBe("0 0 128 128");
    }
  });

  it("nothing in the third-party folder is a script, an event handler, an external reference or a foreign object", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    const all = walk(join(ROOT, "brand", "third-party"));
    const files = all.filter((f) => f.endsWith(".svg"));
    expect(files.length).toBe(Object.keys(SOURCE).length);
    expect(all.filter((f) => f.endsWith(".png")).length).toBe(Object.keys(RASTER).length);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/<script|<foreignObject|<iframe|<image|\son\w+=|javascript:|<animate|<set\b/i);
      expect(text.replace(/xmlns(?::\w+)?="[^"]*"/g, ""), f).not.toMatch(/(?:href|src)="(?:https?:)?\/\//i);
    }
    for (const [k, a] of Object.entries(BRAND_ART)) {
      const vector = k in RASTER ? "" : a.markup;
      expect(vector, k).not.toMatch(/<script|<foreignObject|<iframe|<image|\son\w+=|javascript:|<animate|<style/i);
      expect(a.markup, k).not.toMatch(/https?:\/\//);
      if (k in RASTER) expect(a.markup, k).not.toMatch(/<script|<foreignObject|<iframe|\son\w+=|javascript:|<animate|<style|href="(?!data:image\/)/i);
    }
  });

  it("no sprite id is used twice, and every url(#id) and href=#id resolves inside the sprite", () => {
    const html = page();
    const ids = [...html.matchAll(/\sid="(nl-[^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const sprite = doc.querySelector(".st-sprite")!;
    for (const m of sprite.innerHTML.matchAll(/url\(#([^)]+)\)|href="#([^"]+)"/g)) expect(ids, m[0]).toContain(m[1] ?? m[2]);
  });
});

describe("the page asks no other origin for anything", () => {
  it.each(LOCALES)("(%s) no img, no external src, no external <use>, no stylesheet or font link — only inline SVG", (locale) => {
    const html = page(locale);
    const doc = new DOMParser().parseFromString(html, "text/html");
    // The one allowed picture is the example stills (img.ml-scene), a same-origin build file; nothing remote.
    expect(doc.querySelectorAll("img:not(.ml-scene), picture, video, audio, source, iframe, object, embed, link[rel=stylesheet]")).toHaveLength(0);
    for (const img of doc.querySelectorAll("img.ml-scene")) expect(img.getAttribute("src") ?? "", "an example still is a same-origin file").not.toMatch(/^(?:https?:)?\/\//);
    // The only pictures are the two embedded ones (data: URIs inside the sprite): nothing is fetched.
    for (const im of doc.querySelectorAll("image")) expect(im.getAttribute("href"), "an <image> carries its own bytes").toMatch(/^data:image\/(png|webp);base64,/);
    for (const use of doc.querySelectorAll("use")) expect(use.getAttribute("href"), "a <use> points inside the page").toMatch(/^#nl-/);
    // The only absolute addresses are links a person follows (the Claude and ChatGPT steps, off by default here).
    for (const el of doc.querySelectorAll("[src]:not(img.ml-scene), [srcset], [data]")) throw new Error(`unexpected resource attribute on <${el.tagName.toLowerCase()}>`);
    for (const a of doc.querySelectorAll("a[href^='http']")) expect(a.getAttribute("rel") ?? "").toContain("noopener");
  });

  it("the sprite is small: the drawings of every shown mark together weigh under 60 KB", () => {
    const shown = shownSymbols(MCP_CLIENTS.map((c) => c.id));
    const bytes = shown.reduce((n, s) => n + BRAND_ART[s].markup.length + BRAND_ART[s].viewBox.length, 0);
    expect(bytes).toBeLessThan(60_000);
    const html = page();
    expect((html.match(/<symbol /g) ?? []).length).toBe(shown.length);
  });

  it("a logo is a few bytes of <use>, not the drawing again", () => {
    const one = renderToStaticMarkup(<BrandLogo id="cursor" />);
    expect(one.length).toBeLessThan(400);
    expect(one).toContain('href="#nl-cursor-light"');
    expect(one).toContain('href="#nl-cursor-dark"');
  });
});

describe("where the logos show", () => {
  it.each(LOCALES)("(%s) on every tab pill and every hero tile, never as the only name; the footnote is on the page", (locale) => {
    const doc = new DOMParser().parseFromString(page(locale), "text/html");
    const pills = [...doc.querySelectorAll('[role="tab"].st-pill')];
    expect(pills).toHaveLength(MCP_CLIENTS.length);
    for (const p of pills) {
      expect(p.querySelector(".st-pill-glyph")?.getAttribute("aria-hidden")).toBe("true");
      expect(p.querySelector(".st-pill-label")?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
    const withLogo = pills.filter((p) => p.querySelector(".st-pill-glyph svg use"));
    // Every tab but "Other" carries its vendor's own mark.
    expect(withLogo.length).toBe(MCP_CLIENTS.length - 1);
    expect(doc.querySelector(".st-trademarks")?.textContent).toBe(devDictionaries[locale].mcp.trademarks);
    expect(devDictionaries[locale].mcp.trademarks.length).toBeGreaterThan(60);
  });

  it("English footnote says what the owner asked: trademarks of their owners, shown only to indicate compatibility, no affiliation or endorsement", () => {
    expect(devDictionaries.en.mcp.trademarks).toBe(
      "Product names and logos are trademarks of their respective owners and are shown only to indicate compatibility; Nightshift is not affiliated with or endorsed by them.",
    );
  });

  it("a mark that needs a light surface sits on the light tile in both themes (Roo Code), the rest on the theme's own", () => {
    const doc = new DOMParser().parseFromString(page(), "text/html");
    const roo = doc.querySelector('.st-pill[data-id="roo-code"] .st-pill-glyph')!;
    expect(roo.getAttribute("data-tile")).toBe("paper");
    expect(doc.querySelector('.st-pill[data-id="cursor"] .st-pill-glyph')?.getAttribute("data-tile")).toBe("theme");
  });

  it("every tab shows its vendor's own mark; only \"Other\" carries a plain icon from the icon set the site already uses", () => {
    const doc = new DOMParser().parseFromString(page(), "text/html");
    const glyph = (id: string) => doc.querySelector(`.st-pill[data-id="${id}"] .st-pill-glyph`)!;
    for (const c of MCP_CLIENTS.filter((x) => x.id !== "other")) {
      expect(glyph(c.id).querySelector("svg use"), c.id).toBeTruthy();
      expect(glyph(c.id).textContent?.trim(), c.id).toBe("");
    }
    expect(glyph("other").querySelector("svg.st-logo-glyph")).toBeTruthy();
    expect(glyph("other").querySelector("use")).toBeNull();
    // The Claude Spark is a loose glyph (no tile); finished icons of their own sit bare; the rest on the theme's neutral tile.
    for (const id of ["claude", "claude-desktop", "claude-code"]) expect(glyph(id).getAttribute("data-tile"), id).toBe("plain");
    for (const id of ["gemini-cli", "hermes"]) expect(glyph(id).getAttribute("data-tile"), id).toBe("bare");
    for (const id of ["codex", "cursor", "vscode"]) expect(glyph(id).getAttribute("data-tile"), id).toBe("theme");
  });

  it("the Anthropic marks are on the page, unmodified: the Claude Spark in the text colour on Claude and Claude Desktop, in clay on Claude Code", () => {
    const html = page();
    expect(html).toContain('id="nl-claude-any"');
    expect(html).toContain('id="nl-claude-spark-any"');
    expect(html).toContain('id="nl-claude-spark-mono"');
    const doc = new DOMParser().parseFromString(html, "text/html");
    const ref = (id: string) => doc.querySelector(`.st-pill[data-id="${id}"] .st-pill-glyph use`)?.getAttribute("href");
    expect(ref("claude")).toBe("#nl-claude-spark-mono");
    expect(ref("claude-desktop")).toBe("#nl-claude-spark-mono");
    expect(ref("claude-code")).toBe("#nl-claude-spark-any");
    // (The hero no longer carries a row of client tiles: a chat card stands there, so the app icon is only in the sprite.)
    expect(doc.querySelector(".st-tiles")).toBeNull();
    // The vendor's own colour, as its file has it; the one-colour spark takes the pill's text colour.
    expect(BRAND_ART["claude-spark-any"].markup).toMatch(/#d97757/i);
    expect(BRAND_ART["claude-spark-mono"].markup).toContain("currentColor");
    expect(BRAND_ART["claude-any"].markup).toMatch(/#D97757/i);
  });

  it("a loose glyph has no tile, no border, and follows the pill's text colour (so it is muted, and inverts on the selected pill)", () => {
    const css = readFileSync(join(ROOT, "components", "site", "site.css"), "utf8");
    const rule = css.match(/\.st-pill-glyph\[data-tile="plain"\],\s*\.st-pill\[aria-selected="true"\] \.st-pill-glyph\[data-tile="plain"\]\s*\{([^}]*)\}/);
    expect(rule, "plain tile rule").toBeTruthy();
    expect(rule![1]).toMatch(/background:\s*none/);
    expect(rule![1]).toMatch(/border:\s*0/);
    expect(rule![1]).toMatch(/color:\s*inherit/);
  });

  it("Codex carries the OpenAI mark under OpenAI's terms; Gemini CLI and Hermes their vendors' own icons", () => {
    const doc = new DOMParser().parseFromString(page(), "text/html");
    const uses = (id: string) => [...doc.querySelectorAll(`.st-pill[data-id="${id}"] .st-pill-glyph use`)].map((u) => u.getAttribute("href"));
    expect(uses("codex")).toEqual(["#nl-openai-light", "#nl-openai-dark"]);
    expect(uses("gemini-cli")).toEqual(["#nl-gemini-any"]);
    expect(uses("hermes")).toEqual(["#nl-hermes-any"]);
  });

  it("the sprite exists once and holds exactly the marks that are shown", () => {
    const html = renderToStaticMarkup(<BrandSprite ids={MCP_CLIENTS.map((c) => c.id)} />);
    expect((html.match(/<svg /g) ?? []).length).toBe(1);
    expect(html).toContain("nl-claude-any");
    expect((html.match(/<symbol /g) ?? []).length).toBe(shownSymbols(MCP_CLIENTS.map((c) => c.id)).length);
  });
});
