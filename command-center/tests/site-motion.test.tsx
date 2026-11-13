// @vitest-environment jsdom
/**
 * The public site's motion and interaction layer (components/site/site-motion.css, components/site/motion/*,
 * docs/design/SITE_MOTION.md). What would break if any of these failed:
 * - a visitor who asked for less motion, or pressed "Pause motion", would still see things move (WCAG 2.2.2);
 * - a phone would get pointer effects that a tap leaves stuck, or the page would shift under the reader (CLS);
 * - a screen reader would hear a counting number instead of the true one, or a model named outside its sample's box;
 * - a key would spin "loading" over a page that is not going anywhere;
 * - a wide screen would be handed a larger file that does not exist, or a phone the large one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode; prefetch?: boolean }) => {
    // next/link's own prop, not an attribute of the <a>.
    const { prefetch, ...attrs } = rest;
    void prefetch;
    return (
      <a href={href} {...attrs}>
        {children}
      </a>
    );
  },
}));

import { dictionaries } from "@/lib/i18n";
import { Landing } from "@/components/landing/Landing";
import { ModelMarquee } from "@/components/site/motion/ModelMarquee";
import { attachCountUp, attachGlassLight, attachMagnetic, attachNavBusy, attachNavGlass, clearBusy } from "@/components/site/motion/attach";
import { MAGNET_MAX, PARALLAX_MAX, magnetOffset, parallaxOffset } from "@/components/site/motion/geometry";
import { willNavigate } from "@/components/site/motion/nav-intent";
import { LARGE_CLIP_FROM, clipRendition, posterSrcSet } from "@/lib/site/renditions";
import type { MoneyAnchor } from "@/lib/landing";
import { PROVIDER_BRANDS } from "./helpers/brands";
import { SAMPLE_CARD, without } from "./helpers/showcase-scope";
import { FIXTURE_ENTRY } from "./fixtures/showcase-entry";

const ROOT = join(__dirname, "..");
const css = readFileSync(join(ROOT, "components/site/site-motion.css"), "utf8");
const NO_MONEY: MoneyAnchor = { pack: { kind: "none" }, api: null, site: null };

/** The text of every `@media (...) { ... }` block whose query contains this text (the same reader as tests/site-next-css.test.ts). */
function mediaBlocks(source: string, needle: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf("@media", from);
    if (at < 0) return out;
    const open = source.indexOf("{", at);
    const query = source.slice(at, open);
    let depth = 0;
    let end = open;
    for (; end < source.length; end++) {
      if (source[end] === "{") depth++;
      else if (source[end] === "}" && --depth === 0) break;
    }
    if (query.includes(needle)) out.push(source.slice(open + 1, end));
    from = end + 1;
  }
}
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const KEYFRAMES = /@keyframes[^{]+\{(?:[^{}]|\{[^{}]*\})*\}/g;

/** matchMedia that answers from a set of queries the "device" matches. */
function device(matches: (q: string) => boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: matches(q), media: q, addEventListener() {}, removeEventListener() {} }));
}
const DESKTOP = (q: string) => /pointer: fine|hover: hover|min-width: 1024px/.test(q) && !/reduce/.test(q);
const REDUCED = (q: string) => /prefers-reduced-motion: reduce/.test(q);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-motion");
  document.body.innerHTML = "";
});

describe("site-motion.css", () => {
  const src = noComments(css);

  it("moves nothing unless motion is allowed: every transition and animation sits in a no-preference block", () => {
    let rest = src;
    for (const inner of mediaBlocks(src, "prefers-reduced-motion: no-preference")) rest = rest.replace(inner, "");
    rest = rest.replace(KEYFRAMES, "");
    expect(rest).not.toMatch(/\btransition\s*:/);
    expect(rest).not.toMatch(/\banimation(?:-name)?\s*:/);
  });

  it("lets the visitor stop everything that repeats: each infinite animation's element is named by a 'Pause motion' rule", () => {
    const running = [...src.matchAll(/([^{}]+)\{[^{}]*animation:[^;{}]*infinite[^;{}]*;/g)].flatMap((m) => m[1].split(",").map((x) => x.trim()));
    expect(running.length).toBeGreaterThanOrEqual(5);
    const at = src.indexOf('html[data-motion="paused"] .nx-btn::before');
    const pauseRule = src.slice(at, src.indexOf("}", at));
    expect(pauseRule).toContain("animation-play-state: paused !important");
    for (const sel of running) {
      // The element the animation runs on, with its pseudo-element: `.nx-sh-media`, `.nx-btn::before`, `.nx-section#samples::before` ...
      const target = sel.replace(/:hover|:not\([^)]*\)|html\[data-fx="on"\]\s*/g, "").replace(/\[[^\]]*\]/g, "").trim();
      const last = target.split(/\s+/).pop()!;
      expect(pauseRule, `${sel} keeps running when motion is paused`).toContain(last);
    }
  });

  it("gives the pointer-follow effects (pull, parallax, spotlight, card zoom) to a fine pointer that can hover only", () => {
    const fine = mediaBlocks(src, "pointer: fine").join("\n");
    for (const needle of ["translate: var(--mg-x", "translate: var(--px", "var(--gx", "scale: 1.04"]) {
      expect(fine, needle).toContain(needle);
      let outside = src;
      for (const inner of mediaBlocks(src, "pointer: fine")) outside = outside.replace(inner, "");
      expect(outside, `${needle} outside a fine-pointer block`).not.toContain(needle);
    }
    // And the scripts ask the same question (env.ts richPointer) and only follow a mouse or a pen.
    const attach = readFileSync(join(ROOT, "components/site/motion/attach.ts"), "utf8");
    // Every pointer listener (pull, parallax, spotlight, the nav's glass and its light, the keys' light) checks it.
    expect((attach.match(/pointerType !== "mouse" && e\.pointerType !== "pen"/g) ?? []).length).toBe(6);
    expect((attach.match(/addEventListener\("pointer(?:move|over)"/g) ?? []).length).toBe(6);
    expect(readFileSync(join(ROOT, "components/site/motion/env.ts"), "utf8")).toContain('"(hover: hover) and (pointer: fine) and (min-width: 1024px)"');
  });

  it("animates transforms, opacity and the two registered numbers only, so no box changes size or place (CLS stays 0)", () => {
    for (const kf of src.match(KEYFRAMES) ?? []) {
      const props = [...kf.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      for (const p of props) expect(["transform", "scale", "translate", "opacity", "--nx-a", "--nx-n"], `${p} in ${kf.slice(0, 30)}`).toContain(p);
    }
    for (const m of src.matchAll(/([^{}]+)\{[^{}]*?\btransition\s*:\s*([^;]+);/g)) {
      const props = m[2].split(/,(?![^(]*\))/).map((part) => part.trim().split(/\s+/)[0]);
      // The nav's glass indicator stretches to the link's width: it is an absolutely placed pseudo-element behind the words.
      const allowed = m[1].trim() === ".st .st-nav[data-glass]::before" ? ["width", "height"] : [];
      for (const p of props) expect(["transform", "scale", "translate", "opacity", "background-color", "border-color", "color", "box-shadow", "--nx-n", ...allowed], `${p} on ${m[1].trim()}`).toContain(p);
    }
    expect(src).toMatch(/\.st \.st-nav\[data-glass\]::before \{[^}]*position: absolute;/);
    // The header's slimmer bar is a scaled backdrop and lifted contents; its box keeps its height.
    const header = mediaBlocks(src, "min-width: 1024px").join("\n");
    expect(header).toMatch(/\.st-header\[data-scrolled\]::before \{[^}]*transform: scaleY\(0\.88\)/);
    expect(header).not.toMatch(/\.st-header\[data-scrolled\][^{]*\{[^}]*(?:min-height|height|padding)\s*:/);
  });

  it("keeps every selector inside the public frame (.nx, or .st for the shared header and keys)", () => {
    const stripped = src.replace(KEYFRAMES, "").replace(/@property[^{]+\{[^}]*\}/g, "");
    const selectors = [...stripped.matchAll(/(?:^|[};])\s*([^{};@\s][^{};]*)\{/g)].map((m) => m[1].trim()).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(30);
    for (const group of selectors) {
      for (const sel of group.split(/,(?![^(]*\))/).map((s) => s.trim())) {
        expect(sel, `unscoped selector: ${sel}`).toMatch(/\.nx|(?:^|\s)\.st(?:\s|$)|:has\(\.nx\)/);
      }
    }
  });

  it("hides something for the /mcp reveal only after the script marked it, only with motion allowed, and prints it", () => {
    const hidden = [...src.matchAll(/\[data-rv="0"\]\s*\{[^}]*opacity:\s*0/g)];
    expect(hidden.length).toBe(1);
    for (const h of hidden) {
      const inNoPref = mediaBlocks(src, "prefers-reduced-motion: no-preference").some((b) => src.indexOf(b) <= h.index! && h.index! < src.indexOf(b) + b.length);
      expect(inNoPref).toBe(true);
    }
    expect(mediaBlocks(src, "print").join("")).toMatch(/\.ml-land \[data-rv\] \{ opacity: 1; transform: none; \}/);
    expect(readFileSync(join(ROOT, "components/site/SiteEffects.tsx"), "utf8")).toContain('".ml-land .ml-land-in > *"');
  });

  it("shows no pause button: the strip's key is invisible until the keyboard focuses it (site-next.css hides every one)", () => {
    const next = readFileSync(join(ROOT, "components/site/site-next.css"), "utf8");
    expect(next).toMatch(/\.nx-clip-pause:not\(:focus-visible\) \{ position: absolute; width: 1px; height: 1px;[^}]*clip-path: inset\(50%\)/);
    expect(src).not.toMatch(/\.nx-marquee \.nx-clip-pause[^{]*\{[^}]*(?:opacity: 1|clip-path: none|display: (?:block|grid|flex))/);
  });

  it("only places the strip's key; it does not undo the hiding (no size, clip or position of its own)", () => {
    const rule = src.match(/\.nx-marquee \.nx-clip-pause \{([^}]*)\}/)![1];
    expect(rule).not.toMatch(/\b(?:width|height|clip|clip-path|position|overflow|opacity)\s*:/);
  });

  it("keeps the strip still on a touch screen and the turning edge to a fine pointer (no unpausable or stuck motion)", () => {
    for (const block of mediaBlocks(src, "prefers-reduced-motion: no-preference")) {
      if (/\.nx-marquee-track \{ animation|html\[data-fx="on"\] \.nx-marquee-track/.test(block)) expect(src.slice(0, src.indexOf(block)).slice(-120)).toContain("(hover: hover)");
    }
    const fine = mediaBlocks(src, "pointer: fine").join("\n");
    expect(fine).toContain("animation: nx-edge-turn");
    let outside = src;
    for (const inner of mediaBlocks(src, "pointer: fine")) outside = outside.replace(inner, "");
    expect(outside).not.toContain("animation: nx-edge-turn");
  });

  it("lets a click through the see-through strip under the scrolled header", () => {
    const header = mediaBlocks(src, "min-width: 1024px").join("\n");
    expect(header).toContain(".st .st-header[data-scrolled], .st .st-header[data-scrolled] .st-header-row { pointer-events: none; }");
    expect(header).toContain(".st .st-header[data-scrolled] .st-header-row > * { pointer-events: auto; }");
  });

  it("leaves the focus ring alone: no outline is set or removed here", () => {
    expect(src).not.toMatch(/\boutline(?:-[a-z]+)?\s*:/);
    expect(src).not.toMatch(/:focus(?!-visible)/);
  });

  it("is loaded by both public frames, after the sheets it builds on, and both mount the script half", () => {
    for (const f of ["components/legal/PublicShell.tsx", "components/auth/AuthShell.tsx"]) {
      const s = readFileSync(join(ROOT, f), "utf8");
      expect(s.indexOf('import "@/components/site/site-motion.css"'), f).toBeGreaterThan(s.indexOf('import "@/components/site/site-next.css"'));
      expect(s, f).toContain("<SiteMotion />");
    }
  });
});

describe("the glass", () => {
  const src = noComments(css);
  const recipeAt = src.indexOf(".st .st-nav[data-glass]::before,\n");
  const recipe = src.slice(recipeAt, src.indexOf("}", recipeAt));

  it("reads app/glass.css's shared tokens and never redefines one; public-only values are --nx-glass-*", () => {
    expect(recipeAt).toBeGreaterThan(-1);
    for (const sel of [".nx .nx-cta", '.st .st-key[data-tone="quiet"]', ".st .st-signin:hover", ".nx-final .nx-actions .nx-link"]) expect(recipe).toContain(sel);
    // app/glass.css owns the names (and `.ns-glass`): nothing here sets a --glass-* token or styles .ns-glass.
    expect(src).not.toMatch(/(?:^|[\s{;])--glass-[a-z-]+\s*:/);
    expect(src).not.toMatch(/\.ns-glass\b/);
    for (const old of ["--glass-sat)", "--glass-glow", "--hx", "--hy"]) expect(src, old).not.toContain(old);
    for (const t of ["--glass-blur", "--glass-saturate", "--glass-x", "--glass-y", "--glass-spot"]) expect(recipe, t).toContain(`var(${t}`);
    for (const t of ["tint", "sheen", "gloss", "edge-hi", "edge-lo", "rim-hi", "rim-lo", "shadow"]) expect(recipe, t).toContain(`var(--nx-glass-${t}, var(--glass-${t}))`);
    const shared = readFileSync(join(ROOT, "app/glass.css"), "utf8");
    for (const t of ["--glass-tint", "--glass-tint-hover", "--glass-solid", "--glass-gloss", "--glass-sheen", "--glass-saturate", "--glass-spot"]) expect(shared, t).toContain(`${t}:`);
    expect(recipe).toContain("backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate))");
    const fallback = src.slice(src.indexOf("@supports not ((backdrop-filter"));
    expect(fallback.slice(0, fallback.indexOf("}"))).toMatch(/background-color: var\(--nx-glass-solid, var\(--glass-solid\)\)/);
    // The edge is inset shadows, never a border, so turning to glass on hover changes no box's size.
    expect(recipe).not.toMatch(/\bborder(?:-width|-style)?\s*:\s*\d/);
    expect(recipe).toContain("border-color: transparent");
    // The stages that are dark in both themes carry the dark public values.
    expect(src).toMatch(/\.st \.nx-sh, \.st \.nx-final, [^{]*\{\s*--nx-glass-tint:/);
  });

  it("honours prefers-reduced-transparency: the stages' pills and the scrolled header go solid", () => {
    const less = mediaBlocks(src, "prefers-reduced-transparency: reduce").join("\n");
    expect(less).toContain("--nx-glass-tint: var(--nx-glass-solid)");
    expect(less).toContain("--nx-glass-tint-hover: var(--nx-glass-solid)");
    // (Nested inside the header's own 1024 px block.)
    expect(src).toMatch(/@media \(prefers-reduced-transparency: reduce\) \{\s*\.st \.st-header\[data-scrolled\]::before \{ background-color: var\(--ns-ground\); -webkit-backdrop-filter: none; backdrop-filter: none; \}/);
  });

  it("keeps the primary key's colour and its white label above 4.5:1 under the hover light", () => {
    const hover = mediaBlocks(src, "hover: hover").join("\n");
    const light = hover.match(/\.nx-btn:hover:not\(:focus-visible\)[^{]*\{[^}]*?rgba\(255, 255, 255, ([\d.]+)\), transparent/);
    expect(light).toBeTruthy();
    // White over the lit key (#5b4ee9 in the dark theme, the darkest hover) mixed with this much white.
    const a = Number(light![1]);
    const mix = [0x5b, 0x4e, 0xe9].map((c) => c + (255 - c) * a);
    const lin = mix.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    expect(1.05 / (L + 0.05)).toBeGreaterThanOrEqual(4.5);
    expect(hover).not.toMatch(/\.nx-btn:hover[^{]*\{[^}]*background(?:-color)?\s*:/);
  });

  it("slides one indicator to the hovered or keyboard-focused link, never for a tap, and lets go", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    device(DESKTOP);
    document.body.innerHTML = `<nav class="st-nav"><a href="/a">A</a><a href="/b">Bee</a></nav><p id="out">x</p>`;
    const [a, b] = [...document.querySelectorAll<HTMLAnchorElement>(".st-nav a")];
    Object.defineProperty(a, "offsetLeft", { value: 0 });
    Object.defineProperty(a, "offsetWidth", { value: 40 });
    Object.defineProperty(b, "offsetLeft", { value: 42 });
    Object.defineProperty(b, "offsetWidth", { value: 70 });
    const nav = document.querySelector<HTMLElement>(".st-nav")!;
    const pointer = (type: string, el: Element, pointerType: string, related: Element | null = null) => {
      const e = new MouseEvent(type, { bubbles: true, relatedTarget: related });
      Object.defineProperty(e, "pointerType", { value: pointerType });
      el.dispatchEvent(e);
    };
    const stop = attachNavGlass();
    expect(nav.hasAttribute("data-glass")).toBe(true);
    pointer("pointerover", a, "touch");
    expect(nav.hasAttribute("data-ind")).toBe(false);
    pointer("pointerover", a, "mouse");
    expect(nav.hasAttribute("data-ind")).toBe(true);
    expect(nav.style.getPropertyValue("--ind-w")).toBe("40px");
    pointer("pointerout", a, "mouse", b);
    pointer("pointerover", b, "mouse");
    expect([nav.style.getPropertyValue("--ind-x"), nav.style.getPropertyValue("--ind-w")]).toEqual(["42px", "70px"]);
    pointer("pointerout", b, "mouse", document.getElementById("out"));
    expect(nav.hasAttribute("data-ind")).toBe(false);
    stop();
    expect(nav.hasAttribute("data-glass")).toBe(false);
    // The light inside a key follows a mouse only.
    document.body.innerHTML = `<a class="st-key" href="/signup">Start</a>`;
    const key = document.querySelector<HTMLElement>(".st-key")!;
    const off = attachGlassLight();
    pointer("pointermove", key, "touch");
    expect(key.style.getPropertyValue("--glass-x")).toBe("");
    pointer("pointermove", key, "mouse");
    expect(key.style.getPropertyValue("--glass-x")).not.toBe("");
    off();
    expect(key.style.getPropertyValue("--glass-x")).toBe("");
  });
});

describe("the pointer arithmetic", () => {
  const box = { left: 100, top: 100, width: 200, height: 60 };
  it("pulls a key at most 6 px toward the pointer, and not at all when the pointer is at its centre", () => {
    expect(magnetOffset(box, 200, 130)).toEqual({ x: 0, y: 0 });
    for (const [x, y] of [[0, 0], [5000, -5000], [310, 170], [101, 101]]) {
      const o = magnetOffset(box, x, y);
      expect(Math.abs(o.x)).toBeLessThanOrEqual(MAGNET_MAX);
      expect(Math.abs(o.y)).toBeLessThanOrEqual(MAGNET_MAX);
    }
    expect(MAGNET_MAX).toBe(6);
  });
  it("moves the hero's picture at most 8 px, against the pointer, even for a pointer outside the hero", () => {
    expect(PARALLAX_MAX).toBe(8);
    expect(parallaxOffset(box, 300, 160)).toEqual({ x: -8, y: -8 });
    expect(parallaxOffset(box, 100, 100)).toEqual({ x: 8, y: 8 });
    expect(parallaxOffset(box, 99999, -99999)).toEqual({ x: -8, y: 8 });
    expect(parallaxOffset({ left: 0, top: 0, width: 0, height: 0 }, 10, 10)).toEqual({ x: 0, y: 0 });
  });
});

describe("loading on keys that navigate", () => {
  const here = { origin: "https://nightshift.test", pathname: "/", search: "" };
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
  const link = (href: string, attrs: Record<string, string> = {}) => {
    const a = document.createElement("a");
    a.href = new URL(href, here.origin).toString();
    for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
    return a;
  };

  it("says a plain click on a link to another page of ours navigates, and nothing else does", () => {
    expect(willNavigate(click, link("/signup"), here)).toBe(true);
    expect(willNavigate(click, link("/?tab=x"), here)).toBe(true);
    expect(willNavigate(click, link("/#try"), here)).toBe(false);
    expect(willNavigate(click, link("https://elsewhere.test/signup"), here)).toBe(false);
    expect(willNavigate({ ...click, ctrlKey: true }, link("/signup"), here)).toBe(false);
    expect(willNavigate({ ...click, metaKey: true }, link("/signup"), here)).toBe(false);
    expect(willNavigate({ ...click, button: 1 }, link("/signup"), here)).toBe(false);
    expect(willNavigate(click, link("/signup", { target: "_blank" }), here)).toBe(false);
    expect(willNavigate(click, link("/terms.pdf", { download: "" }), here)).toBe(false);
  });

  it("marks the key busy before next/link cancels the browser's navigation, never a modified click, and clears it", () => {
    document.body.innerHTML = `<a class="nx-btn" href="/signup">Start<svg></svg></a><a class="st-key" data-tone="quiet" href="/signup">Quiet</a>`;
    const stop = attachNavBusy();
    const key = document.querySelector<HTMLAnchorElement>(".nx-btn")!;
    // next/link calls preventDefault in React's (bubble-phase) handler; the capture listener has already seen the click.
    key.addEventListener("click", (e) => e.preventDefault());
    key.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
    expect(key.hasAttribute("data-busy")).toBe(false);
    key.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(key.getAttribute("data-busy")).toBe("true");
    // The link keeps its name and role: nothing about it changes but the attribute the stylesheet draws.
    expect(key.textContent).toBe("Start");
    expect(key.hasAttribute("aria-busy")).toBe(false);
    const quiet = document.querySelector<HTMLAnchorElement>("[data-tone='quiet']")!;
    quiet.addEventListener("click", (e) => e.preventDefault());
    quiet.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(quiet.hasAttribute("data-busy")).toBe(false);
    window.dispatchEvent(new Event("pageshow"));
    expect(key.hasAttribute("data-busy")).toBe(false);
    key.setAttribute("data-busy", "true");
    clearBusy();
    expect(key.hasAttribute("data-busy")).toBe(false);
    key.setAttribute("data-busy", "true");
    stop();
    expect(key.hasAttribute("data-busy")).toBe(false);
  });

  it("stops spinning the moment the address changes (path or query), for a key that survives the navigation", () => {
    vi.useFakeTimers();
    try {
      history.replaceState(null, "", "/");
      document.body.innerHTML = `<a class="st-key" href="/signup">Start free</a><a class="nx-btn" href="/?tab=b">B</a>`;
      const stop = attachNavBusy();
      const key = document.querySelector<HTMLAnchorElement>(".st-key")!;
      key.addEventListener("click", (e) => e.preventDefault());
      key.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      vi.advanceTimersByTime(500);
      expect(key.getAttribute("data-busy")).toBe("true");
      // The router commits the new page: the address changes, the header's key is the same element.
      history.pushState(null, "", "/signup");
      vi.advanceTimersByTime(200);
      expect(key.hasAttribute("data-busy")).toBe(false);
      // A query-only change on the same page (/mcp?tab=) clears it too.
      const tab = document.querySelector<HTMLAnchorElement>(".nx-btn")!;
      history.replaceState(null, "", "/");
      tab.addEventListener("click", (e) => e.preventDefault());
      tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(tab.getAttribute("data-busy")).toBe("true");
      history.pushState(null, "", "/?tab=b");
      vi.advanceTimersByTime(200);
      expect(tab.hasAttribute("data-busy")).toBe(false);
      stop();
    } finally {
      vi.useRealTimers();
      history.replaceState(null, "", "/");
    }
  });
});

describe("the magnetic keys", () => {
  const move = (el: Element, pointerType: string) => {
    const e = new MouseEvent("pointermove", { bubbles: true, clientX: 10, clientY: 10 });
    Object.defineProperty(e, "pointerType", { value: pointerType });
    el.dispatchEvent(e);
  };
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
  });

  it("pull on a desktop mouse, and never for touch, on a phone, under reduced motion or with motion paused", () => {
    document.body.innerHTML = `<a class="nx-btn" href="/signup">Start</a>`;
    const key = document.querySelector<HTMLElement>(".nx-btn")!;
    const cases: Array<[string, (q: string) => boolean, string, boolean]> = [
      ["desktop mouse", DESKTOP, "mouse", true],
      ["touch", DESKTOP, "touch", false],
      ["phone", () => false, "mouse", false],
      ["reduced", (q) => DESKTOP(q) || REDUCED(q), "mouse", false],
    ];
    for (const [name, media, pointer, pulls] of cases) {
      device(media);
      key.removeAttribute("style");
      const stop = attachMagnetic();
      move(key, pointer);
      expect(key.style.getPropertyValue("--mg-x") !== "", name).toBe(pulls);
      stop();
      expect(key.style.getPropertyValue("--mg-x"), `${name}: let go on cleanup`).toBe("");
    }
    device(DESKTOP);
    document.documentElement.setAttribute("data-motion", "paused");
    const stop = attachMagnetic();
    move(key, "mouse");
    expect(key.style.getPropertyValue("--mg-x")).toBe("");
    stop();
  });
});

describe("the facts count up", () => {
  let observed: Element[] = [];
  let fire: (els: Element[]) => void = () => undefined;
  beforeEach(() => {
    observed = [];
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: (entries: Partial<IntersectionObserverEntry>[]) => void) {
          fire = (els) => cb(els.map((target) => ({ target, isIntersecting: true })));
        }
        observe(el: Element) {
          observed.push(el);
        }
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.useRealTimers());

  const facts = (below: boolean) => {
    document.body.innerHTML = `<div class="nx"><span data-count="6">6</span><span data-count="1000">1 000</span><span data-count="0">0</span></div>`;
    for (const el of document.querySelectorAll("span"))
      (el as HTMLElement).getBoundingClientRect = () => ({ top: below ? 5000 : 10, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} });
    return [...document.querySelectorAll<HTMLElement>("span")];
  };

  it("counts a plain number that starts below the fold, and the page's text is the true number throughout", () => {
    device(() => false);
    const [six, grouped, zero] = facts(true);
    const stop = attachCountUp();
    // A grouped number would change shape while counting; a zero is never a claim (Landing leaves it out anyway).
    expect(observed).toEqual([six]);
    expect(grouped.hasAttribute("data-counting") || zero.hasAttribute("data-counting")).toBe(false);
    fire([six]);
    expect(six.getAttribute("data-counting")).toBe("true");
    expect(six.style.getPropertyValue("--nx-n")).toBe("6");
    expect(six.textContent).toBe("6");
    vi.advanceTimersByTime(1700);
    expect(six.hasAttribute("data-counting")).toBe(false);
    expect(six.style.getPropertyValue("--nx-n")).toBe("");
    expect(six.textContent).toBe("6");
    stop();
  });

  it("never takes a number already on screen back to 0, and does nothing under reduced motion or when paused", () => {
    device(() => false);
    facts(false);
    attachCountUp()();
    expect(observed).toEqual([]);

    device(REDUCED);
    facts(true);
    attachCountUp()();
    expect(observed).toEqual([]);

    device(() => false);
    const [six] = facts(true);
    document.documentElement.setAttribute("data-motion", "paused");
    const stop = attachCountUp();
    fire([six]);
    expect(six.hasAttribute("data-counting")).toBe(false);
    stop();
  });

  it("does not count on a reload or a back/forward visit (scroll is restored after it runs), nor in forced colours", () => {
    for (const type of ["reload", "back_forward"]) {
      device(() => false);
      vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type } as unknown as PerformanceEntry]);
      facts(true);
      attachCountUp()();
      expect(observed, type).toEqual([]);
      vi.restoreAllMocks();
    }
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "navigate" } as unknown as PerformanceEntry]);
    device((q) => /forced-colors: active/.test(q));
    facts(true);
    attachCountUp()();
    expect(observed).toEqual([]);
    device(() => false);
    const [six] = facts(true);
    attachCountUp()();
    expect(observed).toEqual([six]);
    vi.restoreAllMocks();
  });
});

describe("the models strip", () => {
  const other = { ...FIXTURE_ENTRY, jobId: "0d0d0d0d-1111-4222-8333-444455556666", modelId: "minimax-h3", modelName: "MiniMax H3" };
  const same = { ...FIXTURE_ENTRY, jobId: "0e0e0e0e-1111-4222-8333-444455556666" };

  it("names each model once per copy, each name inside its sample's box, all of it hidden from assistive technology", () => {
    const { container } = render(<ModelMarquee entries={[FIXTURE_ENTRY, same, other]} pause="Pause motion" />);
    const track = container.querySelector(".nx-marquee-track")!;
    expect(track.getAttribute("aria-hidden")).toBe("true");
    const rows = track.querySelectorAll(".nx-marquee-row");
    expect(rows).toHaveLength(2);
    for (const row of rows) expect([...row.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Runway Gen-4.5", "MiniMax H3"]);
    for (const li of track.querySelectorAll("li")) expect(li.closest(SAMPLE_CARD)?.getAttribute("data-model")).toBeTruthy();
    expect(without(container, SAMPLE_CARD).textContent).not.toMatch(PROVIDER_BRANDS);
    // Nothing focusable inside the hidden part; its own pause switch is outside it.
    expect(track.querySelector("a, button, input, [tabindex]")).toBeNull();
    const pause = container.querySelector(".nx-marquee > button.nx-clip-pause")!;
    expect(pause.textContent).toBe("Pause motion");
    expect(pause.closest("[aria-hidden]")).toBeNull();
  });

  it("is not drawn for fewer than two models (one name sliding past is not a strip)", () => {
    expect(render(<ModelMarquee entries={[FIXTURE_ENTRY, same]} pause="Pause motion" />).container.innerHTML).toBe("");
    expect(render(<ModelMarquee entries={[]} pause="Pause motion" />).container.innerHTML).toBe("");
  });

  it.each(["en", "ru", "uz"] as const)("%s landing: the strip sits between the explore grid and the model tiles, and the facts carry their true numbers", (code) => {
    const { container } = render(<Landing t={dictionaries[code]} locale={code} pricing={{ kind: "announced" }} anchor={NO_MONEY} showcase={[]} />);
    const strip = container.querySelector(".nx-marquee");
    if (strip) {
      expect(strip.closest("section")).toBeNull();
      // After the explore grid (and the effects, when the page has them), right before the model tiles.
      expect(["samples", "effects"]).toContain(strip.previousElementSibling?.id);
      const models = container.querySelector("#models");
      if (models) expect(strip.nextElementSibling).toBe(models);
    }
    for (const n of container.querySelectorAll<HTMLElement>(".nx-facts-n")) {
      expect(n.dataset.count).toMatch(/^\d+$/);
      // The digits in the page are the server's: the count-up only ever draws over them.
      expect(n.textContent!.replace(/\D/g, "")).toBe(n.dataset.count);
    }
  });
});

describe("renditions", () => {
  const f = { poster: "/p.webp", posterSm: "/p-sm.webp" };

  it("offers the 640 and 1280 stills as before, and a larger one only when the sample has one wider than 1280", () => {
    expect(posterSrcSet(f)).toBe("/p-sm.webp 640w, /p.webp 1280w");
    expect(posterSrcSet({ ...f, lg: { poster: "/p-lg.webp", width: 2048, clip: null } })).toBe("/p-sm.webp 640w, /p.webp 1280w, /p-lg.webp 2048w");
    // A "large" file that is not larger is not offered (it would be an upscale's place in the list).
    expect(posterSrcSet({ ...f, lg: { poster: "/p-lg.webp", width: 1280, clip: null } })).toBe("/p-sm.webp 640w, /p.webp 1280w");
  });

  it("plays the large clip only for a wide frame on a screen with the pixels for it and a fast link", () => {
    const wide = { small: false, hasLarge: true, devicePixels: LARGE_CLIP_FROM, fast: true };
    expect(clipRendition(wide)).toBe("lg");
    expect(clipRendition({ ...wide, hasLarge: false })).toBe("md");
    expect(clipRendition({ ...wide, devicePixels: 1440 })).toBe("md");
    expect(clipRendition({ ...wide, fast: false })).toBe("md");
    expect(clipRendition({ ...wide, small: true })).toBe("sm");
  });
});
