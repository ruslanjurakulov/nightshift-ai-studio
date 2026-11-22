/**
 * L1-02 (live audit 2026-11-21, 1920x1080).
 *
 * 1. /all-channels/studio grew a horizontal scrollbar and cut the deck's last key ("Qadamni tanlang"). The deck dropped its words by
 *    the WINDOW's width (@media 1180/1100), but with Nightshift AI docked beside the canvas the deck is ~400 px narrower than the
 *    window: at 1920 its Uzbek row (~1340 px) overflowed its ~1310 px column and spilled past the viewport.
 * 2. "IP geolokatsiyasi: DB-IP" floated as a blurred ghost on operator sections (/videos, /research, /editor): SectionShell draws a
 *    fixed, dimmed, blurred scrim at z-0 over the window and the page's card at z-10; the credit had no z-index, so it was painted
 *    under the scrim and its licence link (CC BY 4.0 asks for it) could not be clicked.
 *
 * jsdom has no layout, so these pin the CSS and markup that make each fix, the way studio-bar-over-rail.test.ts does.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
// CRLF on a Windows checkout would split the multi-line selector below differently from CI's LF.
const css = readFileSync(path.join(root, "components/studio-canvas/studio-canvas.css"), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");

/** Declarations of every top-level rule whose selector list is exactly `sel`, merged in source order. */
function rule(sel: string, source = css): Record<string, string> {
  const re = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "g");
  const out: Record<string, string> = {};
  let found = false;
  for (const m of source.matchAll(re)) {
    found = true;
    for (const line of m[2].split(";")) {
      const [k, ...v] = line.split(":");
      if (k && v.length) out[k.trim()] = v.join(":").trim();
    }
  }
  expect(found, `${sel} rule`).toBe(true);
  return out;
}

/** The bodies of every at-rule block whose prelude starts with `prelude` (one level of nesting). */
function blocks(prelude: string): string[] {
  const out: string[] = [];
  let at = css.indexOf(prelude);
  while (at >= 0) {
    let i = css.indexOf("{", at) + 1;
    const start = i;
    for (let depth = 1; depth > 0; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    out.push(css.slice(start, i - 1));
    at = css.indexOf(prelude, i);
  }
  return out;
}

describe("the Studio deck fits its own column, never the page", () => {
  it("is a size container, so its words go by the deck's width and not the window's", () => {
    const deck = rule(".cv-deck");
    expect(deck.container).toMatch(/^cv-deck\s*\/\s*inline-size$/);
  });

  it("drops the note and the key labels by @container cv-deck, not by a viewport @media (which ignores the docked AI panel)", () => {
    const byDeck = blocks("@container cv-deck").join("\n");
    expect(byDeck).toMatch(/\.cv-qnote\s*\{\s*display:\s*none/);
    expect(byDeck).toMatch(/\.cv-klabel\s*\{\s*display:\s*none/);
    const byWindow = blocks("@media").join("\n");
    expect(byWindow).not.toMatch(/\.cv-qnote/);
    expect(byWindow).not.toMatch(/\.cv-klabel/);
  });

  it("a row that still cannot fit scrolls inside the deck instead of widening the page", () => {
    expect(rule(".cv-deck")["overflow-x"]).toBe("auto");
  });

  it("only the texts give way: keys keep their size, the note shrinks to an ellipsis", () => {
    expect(rule(".cv-deck > *")["flex-shrink"]).toBe("0");
    const note = rule(".cv-deck > .cv-grow,\n.cv-deck > .cv-qnote,\n.cv-deck > .cv-qwhy");
    expect(note["flex-shrink"]).toBe("1");
    expect(note["min-width"]).toBe("0");
    const q = rule(".cv-qnote");
    expect(q["text-overflow"]).toBe("ellipsis");
    expect(q.overflow).toBe("hidden");
  });

  it("the shortened note keeps its whole text in a tooltip", () => {
    const tsx = readFileSync(path.join(root, "components/studio-canvas/StudioCanvas.tsx"), "utf8");
    expect(tsx).toMatch(/<span className="cv-qnote" title=\{c\.nothingSpends\}>\{c\.nothingSpends\}<\/span>/);
  });
});

describe("the DB-IP credit is drawn above an operator section's scrim", () => {
  const zOf = (cls: string) => Number((cls.match(/(?:^|\s)z-(\d+)(?:\s|$)/) ?? [])[1]);

  it("the scrim is a fixed, blurred layer over the whole window (why the credit needs a z-index at all)", () => {
    const shell = readFileSync(path.join(root, "components/SectionShell.tsx"), "utf8");
    const scrim = shell.match(/className="([^"]*section-scrim[^"]*)"/)?.[1] ?? "";
    expect(scrim).toMatch(/\bfixed\b/);
    expect(scrim).toMatch(/\binset-0\b/);
    expect(Number.isFinite(zOf(scrim))).toBe(true);
    const globals = readFileSync(path.join(root, "app/globals.css"), "utf8");
    expect(globals).toMatch(/\.section-scrim\s*\{[^}]*backdrop-filter:\s*blur/);
  });

  it("the credit's box is positioned with a z-index above the scrim's, so it is neither dimmed, blurred nor covered", () => {
    const shell = readFileSync(path.join(root, "components/SectionShell.tsx"), "utf8");
    const scrimZ = zOf(shell.match(/className="([^"]*section-scrim[^"]*)"/)?.[1] ?? "");
    const layout = readFileSync(path.join(root, "app/(app)/layout.tsx"), "utf8");
    const credit = layout.match(/<div className="(app-geo-credit[^"]*)">\s*<GeoAttribution/)?.[1] ?? "";
    expect(credit.split(/\s+/)).toContain("relative");
    expect(zOf(credit)).toBeGreaterThan(scrimZ);
  });

  it("keeps its licence link to db-ip.com", () => {
    const credit = readFileSync(path.join(root, "components/legal/GeoAttribution.tsx"), "utf8");
    expect(credit).toMatch(/href="https:\/\/db-ip\.com"/);
  });
});
