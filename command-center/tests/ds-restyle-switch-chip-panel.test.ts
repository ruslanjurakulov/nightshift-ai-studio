import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The shared switch, chip and panel (components/ui/SegmentedSwitch, Chip, Panel) drawn from the --ds-* tokens
 * (docs/design/SYSTEM.md §3–§5), with the app's one selection colour, lime. What would break without these:
 * - a restyled .ns-* rule that still paints an old name (--ns-amber, --color-*, a hex), so the component changes colour
 *   with the ds-skin remap instead of reading the system's tokens;
 * - the Studio composer's .studio-chip / .studio-seg, which shared those rules, quietly restyled with them (only their
 *   selection colour was meant to move);
 * - a selected key that looks like a focused one (both are lime, so they must differ by shape);
 * - a chip or segment key that shrinks below a thumb on a phone.
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

type Rule = { at: string; sels: string[]; decls: string[] };

/** Every style rule with the at-rules around it, its selector list and its declarations (whitespace collapsed). */
function rules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const at: string[] = [];
  let buf = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") {
      const prelude = buf.trim().replace(/\s+/g, " ");
      buf = "";
      if (prelude.startsWith("@")) {
        at.push(prelude);
        continue;
      }
      const end = src.indexOf("}", i);
      const body = src.slice(i + 1, end);
      i = end;
      const decls = body
        .split(/;(?![^(]*\))/)
        .map((d) => d.trim().replace(/\s+/g, " "))
        .filter(Boolean);
      out.push({ at: at.join(" "), sels: prelude.split(/,(?![^(]*\))/).map((s) => s.trim()), decls });
    } else if (c === "}") {
      at.pop();
      buf = "";
    } else if (c === ";" && buf.trim().startsWith("@")) {
      buf = "";
    } else buf += c;
  }
  return out;
}

const GLOBALS = read("app/globals.css");
const REDESIGN = read("app/(app)/app-redesign.css");
const GLASS = read("app/(app)/app-glass.css");
const SHARED = /^\.(ns-seg|ns-chip|ns-chip-row|ns-panel|ns-panel-head|ns-panel-title|ns-eyebrow)\b/;
const COLOUR_PROP = /^(color|background|background-color|border|border-color|border-[a-z]+-color|box-shadow|outline|outline-color|fill|stroke)\s*:/;

/** The rules that are the shared components' own: every selector in the list is an .ns-* one of the three. */
const own = (css: string) => rules(css).filter((r) => r.sels.every((s) => SHARED.test(s.replace(/^:where\(body:has\(\.app-shell\)\) /, ""))));

describe("the shared switch, chip and panel paint only --ds-* tokens", () => {
  it("in globals.css and app-redesign.css: no old colour name, no --color-*, no literal colour", () => {
    const leaks: string[] = [];
    for (const [file, css] of [["globals.css", GLOBALS], ["app-redesign.css", REDESIGN]] as const) {
      const mine = own(css);
      expect(mine.length, file).toBeGreaterThan(file === "globals.css" ? 20 : 5);
      for (const r of mine) {
        for (const d of r.decls) {
          if (!COLOUR_PROP.test(d)) continue;
          // Size and type tokens (--ns-chip-h, --ns-t-*) are not colours; everything that paints is --ds-*.
          if (/--ns-|--color-|#[0-9a-f]{3,8}\b|\brgba?\(|--studio-|--glass-/i.test(d)) leaks.push(`${file} ${r.sels.join(", ")} { ${d} }`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("in app-glass.css: the shared chip and switch take no amber, caution or rim edge as their mark", () => {
    const mine = own(GLASS);
    expect(mine.length).toBeGreaterThan(5);
    const leaks = mine.flatMap((r) => r.decls.filter((d) => /--ns-amber|--ns-caution|--ns-select\b/.test(d)).map((d) => `${r.sels[0]} { ${d} }`));
    expect(leaks).toEqual([]);
    // And no rule anywhere in the glass, shared or not, lights a chosen key in amber any more. (The section tabs' line
    // under the current page is a place, aria-current, not a choice: it is not a selection state and is not read here.)
    const amberChoices = rules(GLASS).filter((r) => r.sels.some((s) => /\[(aria-pressed|aria-checked|aria-selected|data-on)="true"\]/.test(s)) && r.decls.some((d) => /--ns-amber|--ns-select\b/.test(d)));
    expect(amberChoices.map((r) => r.sels[0])).toEqual([]);
  });

  it("takes the radii by role: the switch's track a key (12), its keys and a chip a chip (8), a panel a panel (16)", () => {
    const decl = (sel: string) => rules(GLOBALS).filter((r) => r.at === "" && r.sels.length === 1 && r.sels[0] === sel).flatMap((r) => r.decls);
    expect(decl(".ns-seg")).toContain("border-radius: var(--ds-r-key)");
    expect(decl(".ns-seg")).toContain("border: 1px solid var(--ds-border-strong)");
    expect(decl(".ns-seg > button")).toContain("border-radius: var(--ds-r-chip)");
    expect(decl(".ns-chip")).toContain("border-radius: var(--ds-r-chip)");
    expect(decl(".ns-chip")).toContain("border: 1px solid var(--ds-border-strong)");
    expect(decl(".ns-panel")).toContain("border-radius: var(--ds-r-panel)");
    expect(decl(".ns-panel")).toContain("border: 1px solid var(--ds-border)");
  });

  it("marks a pressed, checked or selected key in lime, never amber or blue, with a lamp that still fills", () => {
    const bySel = new Map<string, string[]>();
    for (const r of rules(GLOBALS)) for (const s of r.sels) bySel.set(s, [...(bySel.get(s) ?? []), ...r.decls]);
    for (const s of ['.ns-chip[aria-pressed="true"]', '.ns-chip[role="radio"][aria-checked="true"]', '.ns-chip[data-radio][data-on="true"]']) {
      expect(bySel.get(s), s).toContain("border-color: var(--ds-focus)");
      expect(bySel.get(s), s).toContain("box-shadow: var(--ds-glow-select)");
      expect(bySel.get(`${s}::before`), `${s} lamp`).toContain("background: var(--ds-focus)");
    }
    for (const s of ['.ns-seg > button[aria-pressed="true"]', '.ns-seg > button[aria-checked="true"]', '.ns-seg > button[aria-selected="true"]']) {
      expect(bySel.get(s)!.join("; "), s).toMatch(/box-shadow: inset 0 0 0 1px var\(--ds-focus\), var\(--ds-glow-select\)/);
      expect(bySel.get(s)!.join("; "), s).not.toMatch(/--ds-accent|--studio-cta|--ns-amber/);
    }
    // lit is "the chosen one": the same lime; warn is the warning colour.
    expect(GLOBALS).toMatch(/\.ns-chip\[data-tone="lit"\],[^{]*\{ color: var\(--ds-focus\); border-color: var\(--ds-focus\); \}/);
    expect(GLOBALS).toMatch(/\.ns-chip\[data-tone="warn"\],[^{]*\{ color: var\(--ds-warning\); border-color: var\(--ds-warning\); \}/);
    // The glass's chosen tint is lime too (it was amber under a lime edge: two selection colours on one key).
    const glassTokens = read("app/glass.css");
    const selects = [...glassTokens.matchAll(/--glass-select:\s*([^;]+);/g)].map((m) => m[1]);
    expect(selects).toHaveLength(3);
    for (const v of selects) expect(v).toMatch(/^color-mix\(in srgb, var\(--ds-focus\) \d+%/);
  });
});

describe("selection and focus are both lime, so they differ by shape", () => {
  it("selection is the key's own edge (inset / border, no outline); focus is a 3px outline at least 2px outside", () => {
    const all = rules(GLOBALS);
    const selected = all.filter((r) => r.sels.some((s) => /^\.ns-(seg > button|chip)\[(aria-pressed|aria-checked|aria-selected)="true"\]$/.test(s) || /^\.ns-chip\[(role="radio"\]\[aria-checked|data-radio\]\[data-on)="true"\]$/.test(s)));
    expect(selected.length).toBeGreaterThanOrEqual(4);
    for (const r of selected) expect(r.decls.join("; "), r.sels.join(", ")).not.toMatch(/outline/);

    const focus = all.find((r) => r.sels.includes(".ns-chip:focus-visible") && r.sels.includes(".ns-seg > button:focus-visible"));
    expect(focus, "the shared keys' focus rule").toBeDefined();
    expect(focus!.at, "unlayered, like the global ring it refines").toBe("");
    expect(focus!.decls).toContain("outline: 3px solid var(--ds-focus)");
    const offset = focus!.decls.find((d) => d.startsWith("outline-offset:"))!;
    expect(parseFloat(offset.split(":")[1])).toBeGreaterThanOrEqual(2);
    // Focus draws no edge or glow of its own, so it can never be read as "chosen".
    expect(focus!.decls.join("; ")).not.toMatch(/box-shadow|border-color|background/);

    const radioFocus = all.find((r) => r.sels.includes(".ns-chip[data-radio]:focus-within"))!;
    expect(radioFocus.decls).toEqual(["outline: 3px solid var(--ds-focus)", "outline-offset: 2px"]);
  });

  it("the global ring and the default border colour stay unlayered, so they keep winning as before", () => {
    const all = rules(GLOBALS);
    const ring = all.find((r) => r.sels.length === 1 && r.sels[0] === ":focus-visible")!;
    expect(ring.at).toBe("");
    expect(ring.decls).toContain("outline: 3px solid var(--ns-focus)");
    expect(ring.decls).toContain("outline-offset: 2px");
    const dflt = all.find((r) => r.sels[0].startsWith(":where(*:not(.st):not(.st *)"))!;
    expect(dflt.at).toBe("");
    expect(dflt.decls).toEqual(["border-color: var(--color-border)"]);
  });
});

describe("the Studio composer's chips and segments", () => {
  // Every .studio-chip / .studio-seg rule as it stood on main before the restyle, in these four stylesheets, with ONE
  // change applied: in a pressed rule, --ns-amber / --ns-amber-ink became --ds-focus and --ns-select --ds-select-soft
  // (one selection colour across the app). Anything else that differs is the composer restyled by accident.
  const FIXTURE = JSON.parse(read("tests/fixtures/studio-composer-rules.json")) as Record<string, string[][]>;
  const FILES = ["app/globals.css", "app/(app)/app-glass.css", "app/(app)/app-redesign.css", "components/studio/desk.css"];

  it("keep every declaration they had, except the selection colour", () => {
    const now: Record<string, string[][]> = {};
    for (const f of FILES) {
      for (const r of rules(read(f))) {
        for (const sel of r.sels) {
          if (!/\.studio-(chip|seg)\b/.test(sel)) continue;
          (now[`${f} ${r.at ? `${r.at} ` : ""}${sel}`] ??= []).push(r.decls);
        }
      }
    }
    expect(Object.keys(FIXTURE).length).toBeGreaterThan(30);
    expect(now).toEqual(FIXTURE);
  });

  it("and their pressed state is the same lime as the shared chip's", () => {
    expect(FIXTURE['app/globals.css .studio-chip[aria-pressed="true"]'][0]).toContain("border-color: var(--ds-focus)");
    expect(FIXTURE['app/(app)/app-redesign.css .studio-seg > button[aria-pressed="true"]'][0]).toContain("box-shadow: inset 0 -2px 0 var(--ds-focus)");
  });
});

describe("a thumb's worth on a phone", () => {
  it("keeps the segment keys and the chips 44px under a finger", () => {
    const coarse = rules(GLOBALS).filter((r) => r.at === "@media (pointer: coarse), (max-width: 40rem)");
    const minH = (sel: string) => coarse.filter((r) => r.sels.includes(sel)).flatMap((r) => r.decls);
    expect(minH(".ns-seg > button")).toContain("min-height: 44px");
    // The large switch sets its own 36px at (0,2,1); the phone rule must name it too, or it stays 36 (it did, at 390px).
    expect(minH('.ns-seg[data-size="lg"] > button')).toContain("min-height: 44px");
    expect(minH(".ns-chip:not([data-plain])")).toContain("min-height: 44px");
    expect(minH(".ns-chip[data-radio]")).toContain("min-height: 44px");
    expect(minH(".studio-seg > button")).toContain("min-height: 44px");
    expect(minH(":root")).toContain("--ns-chip-h: 44px");
    // The chip's own height still reads the token, so the coarse value above reaches it.
    expect(rules(GLOBALS).find((r) => r.at === "" && r.sels.length === 1 && r.sels[0] === ".ns-chip")!.decls).toContain("min-height: var(--ns-chip-h)");
  });
});

describe("one selection colour across the app: lime, never amber", () => {
  // Every stylesheet the signed-in app loads. The public site (components/site/, the landing's .lp-*) is left out on purpose:
  // the owner kept it as it looked before 20 November (lib/skin.ts), amber included.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".css") && !p.startsWith("components/site/")) files.push(p);
    }
  };
  walk("app");
  walk("components");

  // A person chose this: pressed, checked, selected, on, a ticked box. aria-current (a place, "you are here") is not a choice.
  const CHOSEN = /\[(aria-pressed|aria-checked|aria-selected|data-selected|data-on|data-checked)="true"\]|\.is-sel\b|\.is-selected\b|:checked/;
  const PAINT = /^(color|background|background-color|background-image|border|border-color|border-[a-z]+(-color)?|box-shadow|outline|outline-color|fill|stroke|accent-color)\s*:/;
  // The amber names and values (the canvas's and the timeline's --amber/--sel are lime by value, but a rule that reads an
  // "amber" name is one theme edit away from painting amber again), and the machine's blue.
  const AMBER = /--ns-amber|--amber\b|--amber-|--ns-select\b|--fs-amber|--ns-warm|#f29a1e|#ffa940|#ffb547|\b255 169 64\b|\b242 154 30\b|\b255 181 71\b/i;
  const BLUE = /--ns-act\b|--ns-act-|--run\b|--ds-accent|--color-primary|--studio-cta-bg|--ns-cta-bg/;
  // Decided, each for a stated reason, and nothing else:
  const KEPT: Record<string, string> = {
    // The intelligence map's lit stage is the machine running (its lamp says "run"), not something a person chose.
    '.g4 .g4-map-node[data-on="true"]': "machine state",
    // The Create tabs underline in their own media kind's hue: type identity (SYSTEM.md §4), not a selection colour.
    '.cs-tab[aria-selected="true"]': "media type hue",
    '.cs-tab[aria-checked="true"]': "media type hue",
    // The composer's segment key in globals.css: every app page overrides it (app-redesign.css, app-glass.css: the lime line),
    // and the composer fixture above pins it as it was.
    '.studio-seg > button[aria-pressed="true"]': "overridden in the app, pinned",
    // The design system's own switch (tokens.css) is the primary blue by its spec; it is not one of the amber states.
    '.ds-toggle[aria-checked="true"]': "the ds switch's spec",
    // A selected card that is also being made: the selection is the lime inner edge, the blue band is the job running.
    ".lv-card.is-selected.is-working": "machine state beside the lime mark",
  };

  const seen = new Set<string>();
  const offenders = () => {
    const out: string[] = [];
    for (const f of files) {
      for (const r of rules(read(f))) {
        for (const sel of r.sels) {
          if (!CHOSEN.test(sel) || /:focus/.test(sel)) continue;
          const bare = sel.replace(/^:where\(body:has\(\.app-shell\)\) /, "");
          if (bare in KEPT) {
            seen.add(bare);
            continue;
          }
          for (const d of r.decls) {
            if (!PAINT.test(d) && !/^--g-(tint|edge)/.test(d)) continue;
            if (AMBER.test(d) || BLUE.test(d)) out.push(`${f} ${sel} { ${d} }`);
          }
        }
      }
    }
    return out;
  };

  it("no chosen state anywhere in the app is painted in an amber name or value, or in the machine's blue", () => {
    expect(files.length).toBeGreaterThan(30);
    expect(offenders()).toEqual([]);
    // Every exception still names a rule that exists, so the list cannot quietly outlive what it excused.
    expect([...seen].sort()).toEqual(Object.keys(KEPT).sort());
  });

  it("the ones that moved paint the lime tokens", () => {
    const LIME = /var\(--ds-focus\)|var\(--ds-select-soft\)|var\(--ds-glow-select\)|var\(--sel\)|var\(--sel-soft\)|var\(--glass-select\)/;
    const want: [string, string][] = [
      ["components/studio-canvas/studio-canvas.css", ".cv-node.is-sel"],
      ["components/studio-canvas/studio-canvas.css", ".cv-fcard.is-sel"],
      ["components/studio-canvas/studio-canvas.css", ".cv-pill.is-sel"],
      ["components/studio-canvas/studio-canvas.css", ".cv-master.is-sel .cv-master-btn"],
      ["components/studio-canvas/studio-canvas.css", '.cv-kbtn[aria-pressed="true"]'],
      ["components/studio-timeline/studio-timeline.css", ".tl-clip.is-sel"],
      ["components/studio-live/studio-live.css", ".lv-card.is-selected"],
      ["components/studio/desk.css", '.desk-strip-frame[aria-pressed="true"]'],
      ["components/studio/desk.css", '.desk-tool[aria-selected="true"]'],
      ["components/studio/studio-home.css", '.sc-pill[aria-pressed="true"]'],
      ["components/studio/studio-home.css", '.sh-mode[aria-checked="true"]'],
      ["components/prompt/start-box.css", '.sb-chip[aria-pressed="true"]'],
      ["components/films/films.css", '.fs-cell[aria-selected="true"]'],
      ["components/films/films.css", '.fs-pic[aria-pressed="true"]'],
      ["components/ads/ads.css", '.ads-pick[aria-pressed="true"]'],
      ["app/globals.css", '.studio-chip[aria-pressed="true"]'],
      ["app/globals.css", '.ns-chip[aria-pressed="true"]'],
      ["app/globals.css", '.usage-switch[data-on="true"]'],
      ["app/(app)/app-pages-g2.css", '.g2-switch[aria-checked="true"] .g2-switch-track'],
      ["app/(app)/app-redesign.css", '.studio-seg > button[aria-pressed="true"]'],
    ];
    for (const [f, sel] of want) {
      const decls = rules(read(f)).filter((r) => r.sels.includes(sel)).flatMap((r) => r.decls).filter((d) => PAINT.test(d));
      expect(decls.length, `${f} ${sel}`).toBeGreaterThan(0);
      expect(decls.some((d) => LIME.test(d)), `${f} ${sel}: ${decls.join("; ")}`).toBe(true);
    }
    // The timeline's selection names are the app's lime, in every theme (no second, hand-picked green on paper).
    const tl = read("components/studio-timeline/studio-timeline.css");
    expect(tl).toMatch(/--sel: var\(--ds-focus\);/);
    expect(tl).toMatch(/--sel-soft: var\(--ds-select-soft\);/);
    expect(tl).not.toMatch(/--sel: #/);
  });

  it("no chosen state is drawn as the element's own outline: that shape is the focus ring's", () => {
    const out: string[] = [];
    for (const f of files) {
      for (const r of rules(read(f))) {
        const sels = r.sels.filter((s) => CHOSEN.test(s) && !/:focus/.test(s));
        if (!sels.length) continue;
        const outline = r.decls.find((d) => /^outline\s*:/.test(d) && !/:\s*(none|0)\b/.test(d));
        if (!outline) continue;
        // An outline drawn INSIDE a picture the card holds (offset below zero, on a descendant) is the card's own inner edge,
        // and leaves the card's outline to the ring.
        const offset = r.decls.find((d) => d.startsWith("outline-offset:"));
        if (offset && parseFloat(offset.split(":")[1]) < 0 && sels.every((s) => / \S+$/.test(s))) continue;
        out.push(`${f} ${sels.join(", ")} { ${outline} }`);
      }
    }
    expect(out).toEqual([]);
    // Where the focus ring sits 2px off the element, a 2px lime ring flush with the edge runs straight into it (one 4px band on a
    // focused, selected pill, measured in Chromium): those selections are drawn inside the element.
    const first = (f: string, sel: string) => rules(read(f)).find((r) => r.sels.includes(sel))!.decls.find((d) => d.startsWith("box-shadow:"))!;
    expect(first("components/studio-canvas/studio-canvas.css", ".cv-pill.is-sel")).toMatch(/^box-shadow: inset 0 0 0 2px var\(--ds-focus\)/);
    expect(first("components/studio-timeline/studio-timeline.css", ".tl-clip.is-sel")).toMatch(/^box-shadow: inset 0 0 0 2px var\(--sel\)/);
    expect(first("components/studio-canvas/studio-canvas.css", ".cv-master.is-sel .cv-master-btn")).toMatch(/^box-shadow: inset 0 0 0 2px var\(--ds-focus\)/);
    expect(first("components/studio-live/studio-live.css", ".lv-card.is-selected")).toMatch(/^box-shadow: inset 0 0 0 2px var\(--ds-focus\)/);
  });

  it("the lime reads as text and takes its own ink: light #406a00, dark #c8ff2e, the same as --ds-select", () => {
    const tokens = read("app/tokens.css");
    const focus = [...tokens.matchAll(/--ds-focus:\s*(#[0-9a-f]{6});/gi)].map((m) => m[1].toLowerCase());
    const select = [...tokens.matchAll(/--ds-select:\s*(#[0-9a-f]{6});/gi)].map((m) => m[1].toLowerCase());
    expect(focus).toEqual(["#406a00", "#c8ff2e", "#c8ff2e"]);
    // --ds-select is held to 4.5:1 as text on all four grounds (ds-tokens.test.tsx); the lit chip's words are --ds-focus.
    expect(focus).toEqual(select);
  });
});
