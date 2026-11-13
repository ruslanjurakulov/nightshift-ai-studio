"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { EffectMotif } from "@/lib/effects/catalog";

/**
 * An effect card's drawing while the effect has no real sample: a few flat shapes in the effect's two colours that hint at the
 * move (a burst, a spiral, a dive from orbit …). It is deliberately a drawing — flat colour, no texture, no photograph — so it
 * cannot be taken for a result, and the card says so in words beside it (`noSample`). Decorative: hidden from assistive tech.
 *
 * It moves only while at least a fifth of it is on screen (IntersectionObserver), never under prefers-reduced-motion, and not
 * while the public site's "Pause motion" is on (html[data-motion="paused"], lib/site/motion.ts) — all in effects.css. Without
 * IntersectionObserver it stays still: a still drawing is the safe default.
 */
export function EffectArt({ motif, hues }: { motif: EffectMotif; hues: readonly [string, string] }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setLive(e.isIntersecting && e.intersectionRatio >= 0.2), { threshold: [0, 0.2, 0.6] });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const style = { "--fx-a": hues[0], "--fx-b": hues[1] } as CSSProperties;
  return (
    <span ref={ref} aria-hidden className="fx-art" data-motif={motif} data-live={live ? "on" : undefined} style={style}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" focusable="false">
        <Motif motif={motif} />
      </svg>
    </span>
  );
}

const BURST = Array.from({ length: 14 }, (_, i) => {
  const a = (i / 14) * Math.PI * 2;
  const r = 26 + (i % 3) * 7;
  return { dx: Math.round(Math.cos(a) * r), dy: Math.round(Math.sin(a) * r), r: 1.6 + (i % 4) * 0.7, d: (i % 5) * 0.06 };
});
const SNOW = [
  [38, 22], [47, 18], [56, 25], [63, 20], [42, 30], [52, 33], [60, 31], [35, 36], [66, 38], [48, 40], [57, 42],
] as const;
const DROPS = [
  [26, 34, 2.2], [72, 30, 1.6], [64, 66, 2.6], [32, 70, 1.8], [80, 52, 1.4], [20, 54, 1.4], [50, 22, 1.8], [44, 78, 1.5],
] as const;
const SKYLINE = [
  [0, 64, 12], [12, 56, 10], [22, 70, 9], [31, 50, 13], [44, 62, 10], [54, 46, 12], [66, 60, 11], [77, 52, 10], [87, 66, 13],
] as const;

function Motif({ motif }: { motif: EffectMotif }) {
  switch (motif) {
    case "life":
      return (
        <>
          <rect width="100" height="100" className="fx-ground" />
          <g className="fx-push">
            <rect x="18" y="16" width="64" height="68" rx="4" className="fx-card-a" />
            <circle cx="64" cy="34" r="8" className="fx-ink" />
            <path d="M18 70 Q34 56 50 66 T82 62 V84 H18 Z" className="fx-card-b" />
          </g>
          <rect x="-40" y="0" width="22" height="100" className="fx-sweep" />
        </>
      );
    case "burst":
      return (
        <>
          <rect width="100" height="100" className="fx-ground" />
          <rect x="40" y="34" width="20" height="32" rx="4" className="fx-core fx-card-a" />
          {BURST.map((p, i) => (
            <circle
              key={i}
              cx="50"
              cy="50"
              r={p.r}
              className={i % 2 ? "fx-bit fx-card-a" : "fx-bit fx-ink"}
              style={{ "--dx": `${p.dx}px`, "--dy": `${p.dy}px`, animationDelay: `${p.d}s` } as CSSProperties}
            />
          ))}
        </>
      );
    case "spiral":
      return (
        <>
          <rect width="100" height="100" className="fx-ground" />
          <rect x="42" y="28" width="16" height="44" rx="6" className="fx-card-a" />
          <path
            d="M50 86 C20 82 18 66 50 62 C82 58 80 44 50 40 C20 36 22 22 50 18"
            pathLength="100"
            className="fx-ribbon"
          />
        </>
      );
    case "giant":
      return (
        <>
          <rect width="100" height="100" className="fx-ground" />
          <g className="fx-stride">
            <circle cx="30" cy="22" r="7" className="fx-ink" />
            <rect x="22" y="29" width="16" height="30" rx="7" className="fx-ink" />
          </g>
          {SKYLINE.map(([x, y, w], i) => (
            <rect key={i} x={x} y={y} width={w} height={100 - y} className="fx-card-a" />
          ))}
          <rect x="0" y="92" width="100" height="8" className="fx-card-b" />
        </>
      );
    case "globe":
      return (
        <>
          <rect width="100" height="100" className="fx-ground" />
          <circle cx="50" cy="44" r="30" className="fx-glass" />
          <path d="M30 56 Q50 46 70 56 V64 Q50 72 30 64 Z" className="fx-card-a" />
          {SNOW.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="1.3" className="fx-flake" style={{ animationDelay: `${(i % 6) * 0.35}s` }} />
          ))}
          <path d="M30 76 H70 L64 88 H36 Z" className="fx-card-b" />
        </>
      );
    case "orbit":
      return (
        <>
          <rect width="100" height="100" className="fx-ground" />
          <g className="fx-dive">
            <circle cx="50" cy="132" r="84" className="fx-card-a" />
            <ellipse cx="34" cy="58" rx="12" ry="3" className="fx-cloud" />
            <ellipse cx="68" cy="66" rx="10" ry="2.5" className="fx-cloud" />
            <circle cx="50" cy="52" r="1.6" className="fx-ink" />
          </g>
        </>
      );
    case "macro":
      return (
        <>
          <rect width="100" height="100" className="fx-ground" />
          <ellipse cx="50" cy="78" rx="30" ry="6" className="fx-card-b" />
          <rect x="32" y="30" width="36" height="44" rx="18" className="fx-blob fx-card-a" />
        </>
      );
    case "freeze":
      return (
        <>
          <rect width="100" height="100" className="fx-ground" />
          {DROPS.map(([x, y, r], i) => (
            <circle key={i} cx={x} cy={y} r={r} className="fx-ink" />
          ))}
          <rect x="44" y="38" width="12" height="26" rx="6" className="fx-card-a" />
          <circle cx="50" cy="50" r="36" className="fx-ring" />
          <g className="fx-spin">
            <circle cx="86" cy="50" r="3" className="fx-ink" />
          </g>
        </>
      );
  }
}
