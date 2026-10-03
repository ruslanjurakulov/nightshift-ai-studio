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
import { ANTHROPIC_MARKS_APPROVED, BRAND_LOGOS, brandLogo, logoShown, shownSymbols } from "@/lib/dev/brand-logos";
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

  it.each(BRAND_LOGOS.filter((b) => b.status !== "official").map((b) => [b.id, b] as const))("%s: a mark that is not shown says why", (_, b) => {
    expect(b.reason?.trim().length ?? 0).toBeGreaterThan(20);
  });

  it("an official mark has a drawing for each theme it needs, all from the sprite sheet", () => {
    for (const b of BRAND_LOGOS.filter((x) => x.status === "official")) {
      expect(b.symbols, b.id).toBeTruthy();
      const s = b.symbols!;
      for (const key of "any" in s ? [s.any] : [s.light, s.dark]) expect(BRAND_ART[key], `${b.id}: ${key}`).toBeTruthy();
    }
  });

  it("Anthropic's marks stay off until its approval is in hand (its guidelines require it first)", () => {
    expect(ANTHROPIC_MARKS_APPROVED).toBe(false);
    for (const id of ["claude", "claude-code", "claude-desktop"]) expect(logoShown(brandLogo(id)), id).toBe(false);
    expect(brandLogo("claude")?.reason).toMatch(/approval/i);
    expect(shownSymbols(MCP_CLIENTS.map((c) => c.id))).not.toContain("claude-any");
  });

  it("the clients whose own rules or assets do not allow a mark keep a plain icon: Claude Code, Hermes, Gemini CLI, Codex", () => {
    for (const id of ["claude-code", "hermes", "gemini-cli", "codex"]) expect(logoShown(brandLogo(id)), id).toBe(false);
  });

  it("the nine that may be shown are shown: ChatGPT, OpenClaw, Cursor, VS Code, Windsurf, Cline, Zed, Roo Code, Warp", () => {
    for (const id of ["chatgpt", "openclaw", "cursor", "vscode", "windsurf", "cline", "zed", "roo-code", "warp"]) expect(logoShown(brandLogo(id)), id).toBe(true);
  });
});

describe("the marks are the vendors' own drawings", () => {
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

  it("the hero never fades or blurs a vendor's mark (owners: exactly as provided, no effects)", () => {
    const css = readFileSync(join(ROOT, "components", "site", "site.css"), "utf8");
    expect(css).toMatch(/\.st-tile\[data-tile\]\s*\{\s*opacity:\s*1;\s*filter:\s*none;\s*\}/);
  });

  it("nothing in the third-party folder is a script, an event handler, an external reference or a foreign object", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
    const files = walk(join(ROOT, "brand", "third-party")).filter((f) => f.endsWith(".svg"));
    expect(files.length).toBe(Object.keys(SOURCE).length);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/<script|<foreignObject|<iframe|<image|\son\w+=|javascript:|<animate|<set\b/i);
      expect(text.replace(/xmlns(?::\w+)?="[^"]*"/g, ""), f).not.toMatch(/(?:href|src)="(?:https?:)?\/\//i);
    }
    for (const [k, a] of Object.entries(BRAND_ART)) {
      expect(a.markup, k).not.toMatch(/<script|<foreignObject|<iframe|<image|\son\w+=|javascript:|<animate|<style/i);
      expect(a.markup, k).not.toMatch(/https?:\/\//);
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
    expect(doc.querySelectorAll("img, image, picture, video, audio, source, iframe, object, embed, link[rel=stylesheet]")).toHaveLength(0);
    for (const use of doc.querySelectorAll("use")) expect(use.getAttribute("href"), "a <use> points inside the page").toMatch(/^#nl-/);
    // The only absolute addresses are links a person follows (the Claude and ChatGPT steps, off by default here).
    for (const el of doc.querySelectorAll("[src], [srcset], [data]")) throw new Error(`unexpected resource attribute on <${el.tagName.toLowerCase()}>`);
    for (const a of doc.querySelectorAll("a[href^='http']")) expect(a.getAttribute("rel") ?? "").toContain("noopener");
  });

  it("the sprite is small: the drawings of every shown mark together weigh under 30 KB", () => {
    const shown = shownSymbols(MCP_CLIENTS.map((c) => c.id));
    const bytes = shown.reduce((n, s) => n + BRAND_ART[s].markup.length + BRAND_ART[s].viewBox.length, 0);
    expect(bytes).toBeLessThan(30_000);
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
    expect(withLogo.length).toBe(shownSymbols(MCP_CLIENTS.map((c) => c.id)).length === 0 ? 0 : 9);
    expect(doc.querySelector(".st-trademarks")?.textContent).toBe(devDictionaries[locale].mcp.trademarks);
    expect(devDictionaries[locale].mcp.trademarks.length).toBeGreaterThan(60);
  });

  it("English footnote says what the owner asked: trademarks of their owners, shown only to indicate compatibility, no affiliation or endorsement", () => {
    expect(devDictionaries.en.mcp.trademarks).toBe(
      "Product names and logos are trademarks of their respective owners and are shown only to indicate compatibility; Nightshift is not affiliated with or endorsed by them.",
    );
  });

  it("the centre tile is the Nightshift N on its black tile (the owner's mark), not a lamp", () => {
    const doc = new DOMParser().parseFromString(page(), "text/html");
    const centre = doc.querySelector('.st-tile[data-slot="brand"]')!;
    expect(centre.querySelector("svg")).toBeTruthy();
    expect(centre.querySelector(".st-tile-lamp")).toBeNull();
    expect(centre.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("a mark that needs a light surface sits on the light tile in both themes (Roo Code), the rest on the theme's own", () => {
    const doc = new DOMParser().parseFromString(page(), "text/html");
    const roo = doc.querySelector('.st-pill[data-id="roo-code"] .st-pill-glyph')!;
    expect(roo.getAttribute("data-tile")).toBe("paper");
    expect(doc.querySelector('.st-pill[data-id="cursor"] .st-pill-glyph')?.getAttribute("data-tile")).toBe("theme");
  });

  it("the hero row is real logos only, balanced around the N: no monogram, nothing from a client whose mark is not shown", () => {
    const doc = new DOMParser().parseFromString(page(), "text/html");
    const tiles = [...doc.querySelectorAll(".st-tiles .st-tile")];
    expect(tiles.map((t) => t.getAttribute("data-id"))).toEqual(["cursor", "chatgpt", "openclaw", "nightshift", "vscode", "windsurf", "more"]);
    expect(doc.querySelectorAll(".st-tiles .st-logo-mono")).toHaveLength(0);
    expect(doc.querySelectorAll(".st-logo-mono")).toHaveLength(0);
    // Every client tile is a mark that is shown; the only non-logo tile is the "+" one.
    for (const t of tiles) {
      const id = t.getAttribute("data-id")!;
      if (id === "nightshift" || id === "more") continue;
      expect(logoShown(brandLogo(id)), id).toBe(true);
      expect(t.querySelector("svg use"), id).toBeTruthy();
    }
    expect(tiles.find((t) => t.getAttribute("data-id") === "more")?.textContent).toBe("+");
  });

  it("the tabs whose mark may not be shown carry a plain icon from the icon set the site already uses, never letters", () => {
    const doc = new DOMParser().parseFromString(page(), "text/html");
    const plain = ["claude", "claude-code", "gemini-cli", "codex", "hermes", "claude-desktop", "other"];
    for (const id of plain) {
      const glyph = doc.querySelector(`.st-pill[data-id="${id}"] .st-pill-glyph`)!;
      expect(glyph.querySelector("svg.st-logo-glyph"), id).toBeTruthy();
      expect(glyph.querySelector("use"), id).toBeNull();
      expect(glyph.textContent?.trim(), id).toBe("");
    }
    // The terminal prompt for the command-line agents, the same on all four.
    const terminal = (id: string) => doc.querySelector(`.st-pill[data-id="${id}"] .st-pill-glyph svg`)?.innerHTML;
    expect(new Set(["claude-code", "gemini-cli", "codex", "hermes"].map(terminal)).size).toBe(1);
    expect(terminal("claude")).not.toBe(terminal("claude-code"));
    expect(terminal("claude-desktop")).not.toBe(terminal("claude"));
  });

  it("no Anthropic or Claude drawing is on the page while approval is not in hand", () => {
    const html = page();
    expect(html).not.toContain("nl-claude-any");
    expect(html).not.toMatch(/D97757/i);
  });

  it("the sprite exists once and holds no mark that is not shown", () => {
    const html = renderToStaticMarkup(<BrandSprite ids={MCP_CLIENTS.map((c) => c.id)} />);
    expect((html.match(/<svg /g) ?? []).length).toBe(1);
    expect(html).not.toContain("nl-claude-any");
  });
});
