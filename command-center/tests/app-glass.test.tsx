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

  it("gives up the translucency for a reader who asked for less of it", () => {
    expect(TOKENS).toMatch(/@media \(prefers-reduced-transparency: reduce\)[\s\S]*--glass-tint: var\(--glass-solid\)/);
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
    for (const html of ['<button class="btn-primary" disabled>Go</button>', '<button class="btn-primary" aria-disabled="true">Go</button>']) {
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
