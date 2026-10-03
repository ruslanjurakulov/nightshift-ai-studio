import { useId } from "react";

export type ArtKind = "moon" | "dusk" | "market" | "wave";

/** A fixed, made-up waveform (the same every render, so nothing shifts). */
const WAVE = Array.from({ length: 46 }, (_, i) => 0.3 + 0.62 * Math.abs(Math.sin(i * 0.8) * Math.cos(i * 0.31)));

/**
 * The flat scenes the page draws where a finished result would be. They are
 * drawings, not renders: a few shapes in the identity's own colours, labelled
 * "Example" wherever they appear, so no frame on the page claims to be output
 * the product made. Decorative: the figure that holds one carries the words.
 */
export function Art({ kind }: { kind: ArtKind }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false" className="nx-art">
      {kind === "moon" && (
        <>
          <defs>
            <linearGradient id={`${uid}m`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1b2230" />
              <stop offset="1" stopColor="#0c0f15" />
            </linearGradient>
          </defs>
          <rect width="320" height="180" fill={`url(#${uid}m)`} />
          <circle cx="214" cy="68" r="30" fill="#e9e2d2" />
          <circle cx="226" cy="60" r="30" fill="#161c28" />
          <path d="M0 140 L70 112 L130 132 L205 100 L270 126 L320 108 V180 H0Z" fill="#090c11" />
        </>
      )}
      {kind === "dusk" && (
        <>
          <defs>
            <linearGradient id={`${uid}d`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#3d5a80" />
              <stop offset="0.62" stopColor="#e9c46a" />
              <stop offset="1" stopColor="#b5651d" />
            </linearGradient>
          </defs>
          <rect width="320" height="180" fill={`url(#${uid}d)`} />
          <circle cx="238" cy="96" r="24" fill="#f4d58d" />
          <path d="M0 126 C60 108 110 118 170 124 C230 130 280 112 320 118 V180 H0Z" fill="#a8581a" />
          <path d="M0 150 C70 138 130 150 200 146 C250 143 290 150 320 146 V180 H0Z" fill="#7a3d12" />
          <g fill="#3a2618">
            <rect x="60" y="116" width="34" height="9" rx="3" />
            <rect x="64" y="108" width="8" height="9" rx="3" />
            <rect x="104" y="118" width="34" height="9" rx="3" />
            <rect x="108" y="110" width="8" height="9" rx="3" />
            <rect x="148" y="119" width="34" height="9" rx="3" />
            <rect x="152" y="111" width="8" height="9" rx="3" />
          </g>
        </>
      )}
      {kind === "market" && (
        <>
          <rect width="320" height="180" fill="#8d5b4c" />
          <rect y="112" width="320" height="68" fill="#4a2f27" />
          <path d="M104 112 V78 A56 56 0 0 1 216 78 V112Z" fill="#2a9d8f" />
          <path d="M132 112 V88 A28 28 0 0 1 188 88 V112Z" fill="#1d6f65" />
          <circle cx="262" cy="40" r="14" fill="#f4d58d" />
        </>
      )}
      {kind === "wave" && (
        <>
          <rect width="320" height="180" fill="#12151c" />
          {WAVE.map((h, i) => (
            <rect key={i} x={14 + i * 6.6} y={90 - h * 60} width="3.4" height={h * 120} rx="1.7" fill={i < 22 ? "#ffa940" : "#4b5260"} />
          ))}
        </>
      )}
    </svg>
  );
}
