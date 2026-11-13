// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { GLASS_POINTER_SELECTOR, attachGlassPointer } from "../components/ui/GlassPointer";
import { measureIndicator, resetIndicatorMemory } from "../components/ui/useSlidingIndicator";
import { SegmentedSwitch } from "../components/ui/SegmentedSwitch";

/**
 * The app's glass keys (app/glass.css tokens, app/(app)/app-glass.css on the
 * shared key classes, one pointer listener, one sliding indicator). What would
 * break without these: a listener per button (or one that writes on every
 * pointermove instead of once a frame), a highlight that chases a finger or
 * plays for a reader who asked for less motion, a disabled key that shimmers
 * as if it could be pressed, glass that leaks onto the public pages after a
 * client navigation, no fallback where backdrop-filter is missing, and a
 * segmented switch whose plate is drawn twice or not at all.
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const APP_GLASS = read("app/(app)/app-glass.css");
const TOKENS = read("app/glass.css");
const SCOPE = ":where(body:has(.app-shell))";

afterEach(cleanup);

/** Every rule's selector list in a stylesheet (prelude before `{`, minus at-rules). */
function selectors(css: string): string[] {
  const out: string[] = [];
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /([^{};]+)\{/g;
  for (let m = re.exec(noComments); m; m = re.exec(noComments)) {
    const prelude = m[1].trim();
    if (!prelude || prelude.startsWith("@")) continue;
    for (const sel of prelude.split(/,(?![^(]*\))/)) out.push(sel.trim());
  }
  return out;
}

describe("app-glass.css", () => {
  it("scopes every rule to the signed-in app, so the public pages never take it", () => {
    const all = selectors(APP_GLASS);
    expect(all.length).toBeGreaterThan(50);
    const unscoped = all.filter((s) => !s.startsWith(SCOPE));
    expect(unscoped).toEqual([]);
  });

  it("styles every key the pointer listener lights", () => {
    for (const sel of GLASS_POINTER_SELECTOR.split(", ")) {
      if (sel === ".ns-glass") {
        expect(TOKENS).toContain(".ns-glass {");
        continue;
      }
      const cls = sel.replace(/:not\(.*\)$/, "");
      expect(APP_GLASS, cls).toContain(`${SCOPE} ${cls}`);
    }
  });

  it("has a solid fallback where backdrop-filter does not exist", () => {
    expect(APP_GLASS).toMatch(/@supports not \(\(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\)\)/);
    expect(TOKENS).toMatch(/@supports not \(\(backdrop-filter/);
  });

  it("only lifts, presses and follows the pointer when motion is welcome", () => {
    const motion = APP_GLASS.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(motion).toBeGreaterThan(-1);
    // Every transform that moves a key, and every write of the pointer highlight, sits after that line…
    const before = APP_GLASS.slice(0, motion);
    expect(before).not.toMatch(/transform:\s*(translate|scale)/);
    expect(before).not.toMatch(/--g-sheen:\s*var\(--g-sheen-on\)/);
    // …and the highlight additionally needs a pointer that hovers precisely (never a finger).
    expect(APP_GLASS.slice(motion)).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\s*[^}]*--g-sheen: var\(--g-sheen-on\)/);
  });

  it("keeps a disabled or aria-disabled key flat: no frost, no rim, no highlight, no lift", () => {
    const block = APP_GLASS.match(/\.btn-primary:is\(:disabled, \[aria-disabled="true"\]\),[\s\S]*?\{([^}]*)\}/);
    expect(block, "the disabled rule").not.toBeNull();
    const body = block![1];
    for (const decl of ["--g-sheen: transparent", "--g-gloss: transparent", "backdrop-filter: none", "transform: none", "cursor: not-allowed"]) {
      expect(body, decl).toContain(decl);
    }
  });

  it("is imported last by the app layout, and the tokens right after globals.css", () => {
    const appLayout = read("app/(app)/layout.tsx");
    const imports = [...appLayout.matchAll(/^import "\.\/([^"]+\.css)";$/gm)].map((m) => m[1]);
    expect(imports[imports.length - 1]).toBe("app-glass.css");
    expect(appLayout).toContain("<GlassPointer />");
    const root = read("app/layout.tsx");
    expect(root.indexOf('import "./glass.css"')).toBeGreaterThan(root.indexOf('import "./globals.css"'));
  });
});

/** Ids, then classes/attributes/pseudo-classes, then types: enough of CSS specificity for these selectors. */
function specificity(sel: string): [number, number, number] {
  let s = sel.replace(/::[a-z-]+/g, "");
  const out: [number, number, number] = [0, 0, 0];
  // :where() counts nothing; :not()/:is() count their most specific argument.
  s = s.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, "");
  s = s.replace(/:(not|is)\(((?:[^()]|\([^()]*\))*)\)/g, (_, __, args: string) => {
    const best = args.split(/,(?![^(]*\))/).map((a) => specificity(a.trim())).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
    out[0] += best[0];
    out[1] += best[1];
    out[2] += best[2];
    return "";
  });
  out[0] += (s.match(/#[\w-]+/g) ?? []).length;
  out[1] += (s.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) ?? []).length;
  out[2] += (s.replace(/\[[^\]]+\]/g, "").match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return out;
}
const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

describe("a key that cannot be pressed does not answer the pointer", () => {
  // The positive form of a refused state: a rule written FOR a refused key (to cancel an older hover), not a hover OF one.
  const targetsRefused = (sel: string) => /(^|[^(])(:disabled|\[aria-disabled="true"\]|\[data-disabled="true"\])/.test(sel.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, ""));

  it("every :hover and :active rule excludes disabled and aria-disabled keys, and data-disabled chips", () => {
    const missing: string[] = [];
    for (const sel of selectors(APP_GLASS)) {
      if (!/:(hover|active)\b/.test(sel) || targetsRefused(sel)) continue;
      const need = [":not(:disabled)", ':not([aria-disabled="true"])'];
      if (/\.(ns-chip|studio-chip)\b/.test(sel)) need.push(':not([data-disabled="true"])');
      if (need.some((n) => !sel.includes(n))) missing.push(sel);
    }
    expect(missing).toEqual([]);
  });

  it("the older outlined-key hovers skip a refused key too, without gaining specificity", () => {
    const globals = read("app/globals.css");
    const redesign = read("app/(app)/app-redesign.css");
    for (const [css, sel] of [
      [globals, ".btn-sky.ghost:hover"],
      [globals, ".btn-sky.is-quiet:hover"],
      [redesign, ".btn-sky.ghost:hover"],
      [redesign, ".btn-sky.is-quiet:hover"],
    ] as const) {
      expect(css, sel).toContain(`${sel}:where(:not(:disabled, [aria-disabled="true"]))`);
    }
  });

  it("a key waiting for its price is the only aria-disabled primary that keeps its colour", () => {
    expect(APP_GLASS).toContain('.btn-primary:is(:disabled, [aria-disabled="true"]):not([data-price-hold="loading"])');
    expect(APP_GLASS).not.toMatch(/data-price-hold\]/);
  });
});

describe("page stylesheets that quiet a shared key", () => {
  // A page rule (0,2,0) cannot outrank the glass hover (0,4,0+); it hands the key the neutral glass through tokens instead.
  for (const [file, sel] of [
    ["app/(app)/app-pages-g5.css", ".g5-quiet-keys .btn-primary"],
    ["app/(app)/app-pages-g3.css", ".g3-comment .ns-price-button"],
  ] as const) {
    it(`${sel} sets the neutral glass tokens, so its hover stays quiet`, () => {
      const css = read(file);
      const rule = css.match(new RegExp(`${sel.replace(/[.[\]()]/g, "\\$&")} \\{([^}]*)\\}`));
      expect(rule, sel).not.toBeNull();
      for (const decl of ["--g-tint: var(--glass-tint)", "--g-tint-hover: var(--glass-tint-hover)", "--g-edge-hi: var(--glass-edge-hi)", "--g-fg: var(--color-fg)"]) {
        expect(rule![1], decl).toContain(decl);
      }
      // A literal fill here would be overruled by the glass hover; the tokens are what it reads.
      expect(rule![1]).not.toMatch(/(^|;)\s*background:/);
    });
  }

  it("the filled keys' hover takes its legend colour from --g-fg, never a literal", () => {
    const hover = APP_GLASS.match(/\.btn-primary:hover:not\(\[aria-disabled="true"\]\):not\(:disabled\),[\s\S]*?\{([^}]*)\}/g)!;
    const filled = hover.find((r) => r.includes("--g-tint: var(--g-tint-hover)"));
    expect(filled).toBeDefined();
    expect(filled).toContain("color: var(--g-fg)");
    expect(filled).not.toContain("color: var(--glass-primary-fg)");
  });

  it("a medium PriceButton gives its 1px edge back from its outer legends, so it is not 2px wider", () => {
    expect(APP_GLASS).toContain('.ns-price-button[data-size="md"] > .ns-price-label:first-child { padding-left: calc(1.25rem - 1px); }');
    expect(APP_GLASS).toContain('.ns-price-button[data-size="md"] > .ns-price-tag:last-child { padding-right: calc(1rem - 1px); }');
  });
});

describe("glass tokens", () => {
  const NAMES = [
    "--glass-tint",
    "--glass-tint-hover",
    "--glass-tint-strong",
    "--glass-solid",
    "--glass-gloss",
    "--glass-rim-hi",
    "--glass-rim-lo",
    "--glass-edge-hi",
    "--glass-edge-lo",
    "--glass-sheen",
    "--glass-shadow",
    "--glass-shadow-hover",
    "--glass-press",
    "--glass-primary",
    "--glass-primary-fg",
    "--glass-danger",
    "--glass-danger-fg",
    "--glass-select",
  ];

  it("declares every themed token in light, preferred dark and chosen dark alike", () => {
    // A token declared only under the media query would fall back to the light value for a viewer who picks dark by hand.
    const light = TOKENS.slice(TOKENS.indexOf(":root,\n:root[data-theme=\"light\"]"), TOKENS.indexOf("@media (prefers-color-scheme: dark)"));
    const media = TOKENS.slice(TOKENS.indexOf("@media (prefers-color-scheme: dark)"), TOKENS.indexOf(':root[data-theme="dark"]'));
    const chosen = TOKENS.slice(TOKENS.indexOf(':root[data-theme="dark"]'), TOKENS.indexOf("@media (prefers-reduced-transparency"));
    for (const name of NAMES) {
      for (const [where, block] of [["light", light], ["media dark", media], ["chosen dark", chosen]] as const) {
        expect(block, `${name} in ${where}`).toMatch(new RegExp(`${name}:`));
      }
    }
  });

  it("gives up the translucency for a reader who asked for less of it, whatever the theme", () => {
    // The cascade outcome, worked out per element: under reduced transparency (and a dark preference, the case a bare
    // :root lost), the reduced block must win on the root in every theme state and on a specimen box, by coming later
    // with at least the specificity of every theme rule that sets --glass-tint there.
    const rt = TOKENS.indexOf("@media (prefers-reduced-transparency: reduce)");
    expect(rt).toBeGreaterThan(-1);
    const clean = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rulesSetting = (css: string) =>
      [...clean(css).matchAll(/([^{};]+)\{([^{}]*)\}/g)]
        .filter((m) => /--glass-tint:/.test(m[2]) && !m[1].trim().startsWith("@"))
        .flatMap((m) => m[1].split(/,(?![^(]*\))/).map((x) => x.trim()));
    const themed = rulesSetting(TOKENS.slice(0, rt)).filter((x) => x !== ".ns-glass");
    const reduced = rulesSetting(TOKENS.slice(rt, TOKENS.indexOf("}", TOKENS.indexOf("--glass-blur: 0px")) + 1));
    expect(reduced.length).toBeGreaterThan(0);
    const specimen = (theme: string) => {
      const box = document.body.appendChild(document.createElement("div"));
      box.setAttribute("data-theme-scope", theme);
      return box;
    };
    const states: Array<[string, () => Element]> = [
      ["no choice", () => document.documentElement],
      ["chose light", () => (document.documentElement.setAttribute("data-theme", "light"), document.documentElement)],
      ["chose dark", () => (document.documentElement.setAttribute("data-theme", "dark"), document.documentElement)],
      ["light specimen", () => specimen("light")],
      ["dark specimen", () => specimen("dark")],
    ];
    for (const [name, make] of states) {
      document.documentElement.removeAttribute("data-theme");
      document.body.innerHTML = "";
      const el = make();
      const best = (list: string[]) => list.filter((x) => el.matches(x)).map(specificity).sort((a, b) => cmp(b, a))[0];
      const theme = best(themed);
      const mine = best(reduced);
      expect(theme, `${name}: a theme rule sets the tint`).toBeDefined();
      expect(mine, `${name}: the reduced block reaches it`).toBeDefined();
      expect(cmp(mine!, theme!), `${name}: reduced ${mine} vs theme ${theme}`).toBeGreaterThanOrEqual(0);
    }
    document.documentElement.removeAttribute("data-theme");
    document.body.innerHTML = "";
  });
});

describe("attachGlassPointer", () => {
  let frames: FrameRequestCallback[];
  let reduce: boolean;
  let listeners: Array<() => void>;

  beforeEach(() => {
    frames = [];
    reduce = false;
    listeners = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    window.matchMedia = ((query: string) => ({
      get matches() {
        return query.includes("reduce") && reduce;
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  function key(html = '<button class="btn-quiet"><span>Save</span></button>') {
    document.body.innerHTML = html;
    const el = document.body.firstElementChild as HTMLElement;
    el.getBoundingClientRect = () => ({ left: 100, top: 50, right: 200, bottom: 94, width: 100, height: 44, x: 100, y: 50, toJSON() {} }) as DOMRect;
    return el;
  }
  function move(target: Element, x: number, y: number, pointerType = "mouse") {
    const e = new Event("pointermove", { bubbles: true }) as Event & Record<string, unknown>;
    Object.assign(e, { pointerType, clientX: x, clientY: y });
    target.dispatchEvent(e);
  }

  it("writes the pointer's place inside the key once per frame, however many moves", () => {
    const el = key();
    const detach = attachGlassPointer(window);
    const inner = el.querySelector("span")!;
    move(inner, 110, 60);
    move(inner, 130, 70);
    move(inner, 150, 80);
    expect(frames).toHaveLength(1);
    frames[0](0);
    expect(el.style.getPropertyValue("--glass-x")).toBe("50px");
    expect(el.style.getPropertyValue("--glass-y")).toBe("30px");
    detach();
  });

  it("ignores a finger", () => {
    const el = key();
    const detach = attachGlassPointer(window);
    move(el, 120, 60, "touch");
    expect(frames).toHaveLength(0);
    detach();
  });

  it("leaves a key that cannot be pressed alone (disabled and aria-disabled)", () => {
    for (const html of [
      '<button class="btn-primary" disabled>Go</button>',
      '<button class="btn-primary" aria-disabled="true">Go</button>',
      // A radio chip is a label around its input; it says "refused" with data-disabled (FxControls, ExportRatioPicker…).
      '<label class="ns-chip" data-radio="" data-disabled="true"><input type="radio" disabled>4K</label>',
    ]) {
      const el = key(html);
      const detach = attachGlassPointer(window);
      move(el, 120, 60);
      frames.splice(0).forEach((f) => f(0));
      expect(el.style.getPropertyValue("--glass-x"), html).toBe("");
      detach();
    }
  });

  it("does nothing on an element that is not a glass key", () => {
    const el = key('<div class="panel">text</div>');
    const detach = attachGlassPointer(window);
    move(el, 120, 60);
    frames.splice(0).forEach((f) => f(0));
    expect(el.style.getPropertyValue("--glass-x")).toBe("");
    detach();
  });

  it("is not attached while the reader asks for reduced motion, and follows a change of mind", () => {
    reduce = true;
    const el = key();
    const detach = attachGlassPointer(window);
    move(el, 120, 60);
    expect(frames).toHaveLength(0);
    reduce = false;
    listeners.forEach((fn) => fn());
    move(el, 120, 60);
    expect(frames).toHaveLength(1);
    detach();
    move(el, 120, 60);
    expect(frames).toHaveLength(1);
  });
});

describe("the sliding indicator", () => {
  // jsdom has no layout: give each key a place from its index (100px wide, 4px apart) and the track a width.
  beforeEach(() => {
    resetIndicatorMemory();
    const index = (el: HTMLElement) => (el.parentElement ? Array.from(el.parentElement.children).indexOf(el) : 0);
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
      return 2 + index(this) * 104;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function () {
      return 100;
    });
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function () {
      return 2;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () {
      return 36;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function () {
      return 314;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function () {
      return 40;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const OPTIONS = [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
    { value: "c", label: "C" },
  ] as const;

  it("measures the chosen key as insets of the track", () => {
    document.body.innerHTML = '<div><button aria-checked="false"></button><button aria-checked="true"></button><button></button></div>';
    const track = document.body.firstElementChild as HTMLElement;
    expect(measureIndicator(track, ":scope > button")).toEqual({ l: 106, r: 108, t: 2, b: 2 });
    document.body.innerHTML = "";
  });

  it("puts one plate under the chosen key and says which way it went", () => {
    const { rerender } = render(<SegmentedSwitch label="Mode" options={OPTIONS} value="a" onChange={() => {}} />);
    const track = screen.getByRole("radiogroup", { name: "Mode" });
    expect(track.hasAttribute("data-indicator")).toBe(true);
    expect(track.style.getPropertyValue("--ns-ind-l")).toBe("2px");
    expect(track.style.getPropertyValue("--ns-ind-r")).toBe("212px");
    act(() => rerender(<SegmentedSwitch label="Mode" options={OPTIONS} value="c" onChange={() => {}} />));
    expect(track.style.getPropertyValue("--ns-ind-l")).toBe("210px");
    expect(track.getAttribute("data-ind-dir")).toBe("fwd");
    act(() => rerender(<SegmentedSwitch label="Mode" options={OPTIONS} value="b" onChange={() => {}} />));
    expect(track.getAttribute("data-ind-dir")).toBe("back");
  });

  it("draws no plate when no key is chosen (the mode lives in another group)", () => {
    render(<SegmentedSwitch label="Mode" options={OPTIONS} value={null} onChange={() => {}} />);
    expect(screen.getByRole("radiogroup", { name: "Mode" }).hasAttribute("data-indicator")).toBe(false);
  });

  it("hands the chosen key's own plate over to the travelling one, so it is never drawn twice", () => {
    expect(APP_GLASS).toMatch(/\.ns-seg\[data-indicator\] > button\[aria-checked="true"\][\s\S]*?\{\s*background: transparent;\s*box-shadow: none;/);
  });
});
