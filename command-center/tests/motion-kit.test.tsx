// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { act, useRef, useState } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DISTANCE, DURATION, EASE, PRESS_SCALE, SPRING, STAGGER, staggerDelay } from "../lib/motion/tokens";
import {
  hasMotion,
  lampStrikeProps,
  loadingGraceProps,
  pageEnterProps,
  plateProps,
  presenceProps,
  pressProps,
  revealProps,
  staggerGroupProps,
  staggerItemProps,
  type MotionBits,
} from "../lib/motion/presets";
import { useFreshMount, useReducedMotionSafe } from "../components/motion/hooks";
import { Reveal, RevealText, Stagger, StaggerItem } from "../components/motion/Reveal";
import { Presence, PresenceItem } from "../components/motion/Presence";
import { PageTransition } from "../components/motion/PageTransition";
import { LiveLamp } from "../components/motion/LiveLamp";
import { Plate } from "../components/motion/SharedLayout";
import { LoadingGrace } from "../components/motion/LoadingGrace";
import { StatusLamp } from "../components/ui/StatusLamp";
import { useOverlay } from "../components/a11y/useOverlay";

/**
 * The motion kit's contract (docs/design/MOTION.md). What would break without
 * these: a reduced-motion reader still seeing things slide and fade; a token
 * drifting from the CSS one so the app moves on two clocks; a spring that
 * overshoots on a console that never bounces; an entrance that hides the
 * server-rendered first paint (LCP held hostage by JavaScript); an animation
 * on a layout property that shifts the page; GSAP leaking into a bundle.
 */

const ROOT = process.cwd();

let reduce = false;
beforeEach(() => {
  reduce = false;
  window.matchMedia = ((q: string) => ({
    matches: q.includes("prefers-reduced-motion: reduce") ? reduce : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  })) as never;
});
afterEach(cleanup);

/** Every key any preset animates, through variants and keyframes. */
function animatedKeys(bits: MotionBits): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "transition") continue;
      out.add(k);
    }
  };
  for (const key of ["initial", "animate", "exit", "whileInView", "whileTap"] as const) visit(bits[key]);
  for (const variant of Object.values(bits.variants ?? {})) {
    visit(typeof variant === "function" ? (variant as (i: number) => unknown)(0) : variant);
  }
  return out;
}

const ALL_PRESETS = (reduced: boolean): Record<string, MotionBits> => ({
  revealInView: revealProps(reduced),
  revealMount: revealProps(reduced, { trigger: "mount" }),
  staggerGroup: staggerGroupProps(reduced),
  staggerGroupMount: staggerGroupProps(reduced, { trigger: "mount" }),
  staggerItem: staggerItemProps(reduced, 3),
  staggerWord: staggerItemProps(reduced, 3, { step: 0.03 }),
  popover: presenceProps(reduced, "popover"),
  sheet: presenceProps(reduced, "sheet"),
  toast: presenceProps(reduced, "toast"),
  fade: presenceProps(reduced, "fade"),
  press: pressProps(reduced),
  plate: plateProps(reduced, "rail"),
  lampChanged: lampStrikeProps(reduced, true),
  page: pageEnterProps(reduced, true),
  loading: loadingGraceProps(reduced),
});

describe("tokens", () => {
  it("mirror the CSS tokens in globals.css, so CSS and Motion run on one clock", () => {
    const css = readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
    const ease = css.match(/--ns-ease:\s*cubic-bezier\(([^)]+)\)/)?.[1].split(",").map(Number);
    expect(ease).toEqual([...EASE.standard]);
    const dur = (n: number) => Number(css.match(new RegExp(`--ns-dur-${n}:\\s*(\\d+)ms`))?.[1]) / 1000;
    expect([dur(1), dur(2), dur(3)]).toEqual([DURATION.tap, DURATION.state, DURATION.enter]);
  });

  it("never bounce: every spring is critically damped", () => {
    for (const spring of Object.values(SPRING)) {
      expect(spring.type).toBe("spring");
      expect(spring.bounce).toBe(0);
      expect(spring.visualDuration).toBeLessThanOrEqual(DURATION.enter);
    }
  });

  it("keep travel short and the stagger capped", () => {
    expect(Math.max(...Object.values(DISTANCE))).toBeLessThanOrEqual(16);
    expect(PRESS_SCALE).toBeGreaterThanOrEqual(0.95);
    expect(staggerDelay(0)).toBe(0);
    expect(staggerDelay(2)).toBeCloseTo(2 * STAGGER.step);
    expect(staggerDelay(50)).toBe(staggerDelay(STAGGER.cap));
    expect(staggerDelay(-3)).toBe(0);
  });
});

describe("the reduced-motion contract (presets)", () => {
  it("hands out no motion props at all when reduced", () => {
    for (const [name, bits] of Object.entries(ALL_PRESETS(true))) {
      expect({ name, bits }).toEqual({ name, bits: {} });
      expect(hasMotion(bits)).toBe(false);
    }
  });

  it("animates opacity and transforms only otherwise (no layout properties, so no layout shift)", () => {
    const allowed = new Set(["opacity", "x", "y", "scale"]);
    for (const [name, bits] of Object.entries(ALL_PRESETS(false))) {
      if (name === "plate" || name === "staggerGroup" || name === "staggerGroupMount") continue; // labels / layoutId only
      expect(hasMotion(bits)).toBe(true);
      for (const key of animatedKeys(bits)) expect({ name, key, ok: allowed.has(key) }).toEqual({ name, key, ok: true });
    }
  });

  it("never replays an entrance over the server-rendered first paint", () => {
    expect(pageEnterProps(false, false)).toEqual({});
    expect(revealProps(false, { trigger: "mount", enter: false })).toEqual({});
    expect(staggerGroupProps(false, { trigger: "mount", enter: false })).toEqual({});
  });

  it("leaves faster than it arrives", () => {
    const pop = presenceProps(false, "popover") as { exit: { transition: { duration: number } } };
    expect(pop.exit.transition.duration).toBe(DURATION.tap);
    expect(DURATION.tap).toBeLessThan(DURATION.state);
  });

  it("does not strike a lamp that was already lit when the screen loaded", () => {
    expect(lampStrikeProps(false, false)).toEqual({});
  });

  it("caps travel at a sheet's rise whatever the caller asks for", () => {
    const bits = revealProps(false, { distance: 400 }) as { initial: { y: number } };
    expect(bits.initial.y).toBe(DISTANCE.sheet);
  });
});

describe("hooks", () => {
  function Probe() {
    const reduced = useReducedMotionSafe();
    const fresh = useFreshMount();
    return <span data-reduced={String(reduced)} data-fresh={String(fresh)} />;
  }

  it("read false on the server, whatever the system says, so hydration matches", () => {
    reduce = true;
    const html = renderToString(<Probe />);
    expect(html).toContain('data-reduced="false"');
    expect(html).toContain('data-fresh="false"');
  });

  it("follow the system on a client mount, and call it a fresh mount", () => {
    reduce = true;
    render(<Probe />);
    const el = document.querySelector("span")!;
    expect(el.dataset.reduced).toBe("true");
    expect(el.dataset.fresh).toBe("true");
  });

  it("call a hydrated component NOT fresh, even after it re-renders", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<Probe />);
    document.body.appendChild(container);
    reduce = true;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => {
      hydrateRoot(container, <Probe />);
    });
    const el = container.querySelector("span")!;
    expect(el.dataset.fresh).toBe("false");
    // …while the reduced-motion answer catches up straight after hydration.
    expect(el.dataset.reduced).toBe("true");
    container.remove();
  });
});

describe("components under reduced motion", () => {
  beforeEach(() => {
    reduce = true;
  });

  it("render in place: no start state in the markup, and the CSS guard hook is on every element", () => {
    render(
      <>
        <Reveal data-testid="reveal">a</Reveal>
        <Stagger data-testid="group">
          <StaggerItem index={0} data-testid="item">
            b
          </StaggerItem>
        </Stagger>
        <PageTransition>
          <p data-testid="page">c</p>
        </PageTransition>
        <LoadingGrace>
          <p data-testid="loading">d</p>
        </LoadingGrace>
        <Presence>
          <PresenceItem kind="sheet" data-testid="sheet">
            e
          </PresenceItem>
        </Presence>
      </>,
    );
    for (const id of ["reveal", "group", "item", "sheet"]) {
      const el = screen.getByTestId(id);
      expect(el.getAttribute("style") ?? "").not.toMatch(/opacity|transform/);
      expect(el.hasAttribute("data-ns-motion")).toBe(true);
    }
    for (const id of ["page", "loading"]) {
      const wrap = screen.getByTestId(id).parentElement!;
      expect(wrap.getAttribute("style") ?? "").not.toMatch(/opacity|transform/);
      expect(wrap.hasAttribute("data-ns-motion")).toBe(true);
    }
  });

  it("RevealText is the plain sentence, not words", () => {
    render(<RevealText as="h2" text="Proofs print in order" />);
    const h = screen.getByRole("heading", { level: 2 });
    expect(h.textContent).toBe("Proofs print in order");
    expect(h.querySelectorAll("span").length).toBe(0);
  });
});

describe("components with motion", () => {
  it("an in-view reveal starts hidden in the markup and is marked for the no-script rule", () => {
    render(<Reveal data-testid="r">x</Reveal>);
    const el = screen.getByTestId("r");
    expect(el.getAttribute("style")).toMatch(/opacity:\s*0/);
    expect(el.hasAttribute("data-ns-reveal")).toBe(true);
  });

  it("RevealText keeps one readable sentence for assistive technology", () => {
    render(<RevealText as="h2" text="Proofs print in order" />);
    const h = screen.getByRole("heading", { level: 2 });
    expect(h.querySelector(".sr-only")?.textContent).toBe("Proofs print in order");
    expect(h.querySelector('[aria-hidden="true"]')?.querySelectorAll("span").length).toBe(4);
  });

  it("a server-rendered PageTransition is visible in the HTML (LCP never waits on JS)", () => {
    const html = renderToString(
      <PageTransition>
        <h1>Title</h1>
      </PageTransition>,
    );
    expect(html).not.toMatch(/opacity:\s*0/);
    expect(html).toContain("<h1>Title</h1>");
  });

  it("only an explicit firstPaint entrance is drawn at its start state in the server HTML", () => {
    const plain = renderToString(<Reveal trigger="mount">a</Reveal>);
    expect(plain).not.toMatch(/opacity:\s*0/);
    const hero = renderToString(
      <Reveal trigger="mount" firstPaint>
        a
      </Reveal>,
    );
    expect(hero).toMatch(/opacity:\s*0/);
    expect(hero).toContain("data-ns-reveal"); // shown anyway without script
  });

  it("a PageTransition mounted by a client navigation starts from its rise", () => {
    render(
      <PageTransition>
        <h1>Title</h1>
      </PageTransition>,
    );
    const wrap = screen.getByRole("heading").parentElement!;
    expect(wrap.getAttribute("style")).toMatch(/opacity:\s*0/);
    expect(wrap.getAttribute("style")).toMatch(/translateY\(8px\)/);
  });
});

describe("LiveLamp", () => {
  it("is StatusLamp's own markup at rest", () => {
    const strip = (html: string) => html.replace(/\s(data-ns-motion|style)="[^"]*"/g, "");
    const live = renderToString(<LiveLamp tone="run" label="Running" live />);
    const plain = renderToString(<StatusLamp tone="run" label="Running" live />);
    expect(strip(live)).toBe(strip(plain));
  });

  it("strikes (remounts the lamp) when the state changes, not on first render", () => {
    const { rerender, container } = render(<LiveLamp tone="run" label="Running" live />);
    const first = container.querySelector(".ns-lamp")!;
    expect(first.getAttribute("style") ?? "").not.toMatch(/scale|opacity/);
    rerender(<LiveLamp tone="ok" label="Done" />);
    const second = container.querySelector(".ns-lamp")!;
    expect(second).not.toBe(first);
    expect(second.getAttribute("data-tone")).toBe("ok");
    expect(second.getAttribute("style")).toMatch(/opacity:\s*0\.4/);
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("changes state instantly under reduced motion", () => {
    reduce = true;
    const { rerender, container } = render(<LiveLamp tone="run" label="Running" />);
    rerender(<LiveLamp tone="fail" label="Failed" />);
    const lamp = container.querySelector(".ns-lamp")!;
    expect(lamp.getAttribute("data-tone")).toBe("fail");
    expect(lamp.getAttribute("style") ?? "").not.toMatch(/scale|opacity/);
  });
});

describe("Plate", () => {
  it("is decorative and takes no space", () => {
    const { container } = render(<Plate id="rail" />);
    const plate = container.querySelector(".ns-plate")!;
    expect(plate.getAttribute("aria-hidden")).toBe("true");
    const css = readFileSync(path.join(ROOT, "components/motion/motion.css"), "utf8");
    expect(css).toMatch(/\.ns-plate\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*pointer-events:\s*none/s);
  });
});

describe("motion.css", () => {
  const css = readFileSync(path.join(ROOT, "components/motion/motion.css"), "utf8");
  it("holds every kit element at rest under reduced motion, beating inline styles", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\[data-ns-motion\]\s*\{\s*opacity:\s*1 !important;\s*transform:\s*none !important;/,
    );
  });
  it("shows in-view reveals when there is no script", () => {
    expect(css).toMatch(/@media \(scripting: none\)\s*\{\s*\[data-ns-reveal\]\s*\{\s*opacity:\s*1 !important;/);
  });
  it("is global (root layout), while the engine is mounted only where pages animate", () => {
    const root = readFileSync(path.join(ROOT, "app/layout.tsx"), "utf8");
    expect(root).toContain('import "@/components/motion/motion.css"');
    // LazyMotion pulls ~11 kB gz of Motion's core into every route under it
    // (docs/design/MOTION.md §7): the public pages must not carry it for nothing.
    expect(root).not.toMatch(/<MotionProvider|from "@\/components\/motion\/MotionProvider"/);
    const app = readFileSync(path.join(ROOT, "app/(app)/layout.tsx"), "utf8");
    expect(app).toMatch(/<MotionProvider>/);
  });
});

describe("bundle discipline", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(tsx?|mjs)$/.test(f) ? [p] : [];
    });
  }
  const SOURCES = ["app", "components", "lib"].flatMap((d) => files(path.join(ROOT, d)));

  it("never imports framer-motion, the heavy motion component, or the whole m namespace", () => {
    for (const f of SOURCES) {
      const src = readFileSync(f, "utf8");
      const rel = path.relative(ROOT, f);
      expect({ rel, framer: /from ["']framer-motion/.test(src) }).toEqual({ rel, framer: false });
      expect({ rel, motionComponent: /import\s*\{[^}]*\bmotion\b[^}]*\}\s*from\s*["']motion\/react["']/.test(src) }).toEqual({ rel, motionComponent: false });
      expect({ rel, namespace: /import\s*\*\s*as\s*\w+\s*from\s*["']motion\/react-m["']/.test(src) }).toEqual({ rel, namespace: false });
    }
  });

  it("keeps GSAP behind a dynamic import, in ScrollScene only", () => {
    for (const f of SOURCES) {
      const src = readFileSync(f, "utf8");
      const rel = path.relative(ROOT, f);
      const valueImport = /^import\s+(?!type\b)[^;]*from\s*["']gsap/m.test(src);
      expect({ rel, valueImport }).toEqual({ rel, valueImport: false });
      if (/import\(["']gsap/.test(src)) expect(rel).toBe(path.join("components", "motion", "ScrollScene.tsx"));
    }
  });
});

describe("ScrollScene", () => {
  it("never downloads GSAP under reduced motion or on a narrow screen, and builds once otherwise", async () => {
    const registerPlugin = vi.fn();
    const revert = vi.fn();
    const timeline = vi.fn(() => ({}));
    vi.doMock("gsap", () => ({
      gsap: { registerPlugin, timeline, context: (fn: () => void) => (fn(), { revert }), utils: { selector: () => () => [] } },
    }));
    vi.doMock("gsap/ScrollTrigger", () => ({ ScrollTrigger: {} }));
    const { ScrollScene } = await import("../components/motion/ScrollScene");
    const build = vi.fn();

    reduce = true;
    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    const a = render(<ScrollScene build={build}>static scene</ScrollScene>);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(registerPlugin).not.toHaveBeenCalled();
    a.unmount();

    reduce = false;
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    const b = render(<ScrollScene build={build}>static scene</ScrollScene>);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(registerPlugin).not.toHaveBeenCalled();
    b.unmount();

    Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
    const c = render(<ScrollScene build={build}>static scene</ScrollScene>);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(registerPlugin).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledTimes(1);
    expect(screen.getByText("static scene")).toBeTruthy();
    c.unmount();
    expect(revert).toHaveBeenCalledTimes(1);
    vi.doUnmock("gsap");
    vi.doUnmock("gsap/ScrollTrigger");
  });
});

describe("useOverlay with an overlay that animates out", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    const opener = useRef<HTMLButtonElement>(null);
    const box = useRef<HTMLDivElement>(null);
    useOverlay(open, { onClose: () => setOpen(false), container: box, opener });
    return (
      <>
        <button ref={opener} onClick={() => setOpen(true)}>
          open
        </button>
        {/* Still in the document after closing, as an exiting PresenceItem is. */}
        <div ref={box} tabIndex={-1} data-open={String(open)}>
          <button onClick={() => setOpen(false)}>inside</button>
        </div>
      </>
    );
  }

  it("returns focus to the opener even though the overlay is still in the document", () => {
    render(<Harness />);
    fireEvent.click(screen.getByText("open"));
    screen.getByText("inside").focus();
    expect(document.activeElement).toBe(screen.getByText("inside"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(screen.getByText("open"));
  });
});
