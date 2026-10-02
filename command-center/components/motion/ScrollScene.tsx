"use client";

import { useEffect, useRef } from "react";
import type { gsap as GsapNs } from "gsap";
import { useReducedMotionSafe } from "./hooks";

type Gsap = typeof GsapNs;
type Timeline = ReturnType<Gsap["timeline"]>;

/** Fills the scene's scrubbed timeline. `q` selects inside the scene only. */
export type SceneBuilder = (tl: Timeline, q: (selector: string) => Element[]) => void;

/**
 * A pinned, scroll-scrubbed scene for the PUBLIC marketing pages only — the
 * one place a cinematic sequence earns its cost (docs/design/MOTION.md §GSAP).
 * Everything else in the product uses Motion; never put a ScrollScene in the
 * signed-in app, the Studio or the editor (licence note in MOTION.md).
 *
 * - GSAP and ScrollTrigger are `import()`ed when a scene mounts and the scene
 *   will actually play, so they are a separate chunk on the routes that render
 *   one and nowhere else; no route's first-load JavaScript carries them.
 * - The children are the complete, static scene. With reduced motion, on a
 *   screen narrower than `minWidth` (a phone scrolls past a pin badly), or
 *   before the chunk arrives, that static scene is what is shown — GSAP is
 *   then never even downloaded.
 * - Transforms and opacity only in `build`; ScrollTrigger's pin spacer adds
 *   the scroll length below the scene, so keep a scene below the first
 *   viewport, where that growth cannot count as a layout shift.
 * - `build` is a function, so the component that renders a ScrollScene must
 *   itself be a Client Component.
 */
export function ScrollScene({
  build,
  length = 1.5,
  minWidth = 768,
  className,
  children,
  ...rest
}: {
  build: SceneBuilder;
  /** Scroll distance the scene stays pinned for, in viewport heights. */
  length?: number;
  minWidth?: number;
  className?: string;
  children: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLElement>, "children">) {
  const root = useRef<HTMLElement>(null);
  const reduced = useReducedMotionSafe();
  // The builder is read at set-up time; a new function identity each render
  // must not tear the scene down and rebuild it mid-scroll.
  const builder = useRef(build);
  builder.current = build;

  useEffect(() => {
    const el = root.current;
    if (!el || reduced || window.innerWidth < minWidth) return;
    let cancelled = false;
    let revert: (() => void) | null = null;
    void Promise.all([import("gsap"), import("gsap/ScrollTrigger")]).then(([g, st]) => {
      if (cancelled) return;
      const gsap = g.gsap;
      gsap.registerPlugin(st.ScrollTrigger);
      const ctx = gsap.context(() => {
        const tl = gsap.timeline({
          defaults: { ease: "none" },
          scrollTrigger: { trigger: el, start: "top top", end: `+=${Math.round(length * 100)}%`, pin: true, scrub: 0.4 },
        });
        builder.current(tl, gsap.utils.selector(el));
      }, el);
      revert = () => ctx.revert();
    });
    return () => {
      cancelled = true;
      revert?.();
    };
  }, [reduced, length, minWidth]);

  return (
    <section ref={root} data-ns-scene="" className={className} {...rest}>
      {children}
    </section>
  );
}
