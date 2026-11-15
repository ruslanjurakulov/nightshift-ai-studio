import React from "react";
import { alpha, mix, type Look } from "./looks";
import { hash01 } from "./motion";
import type { Setting } from "./types";

/**
 * The four settings, drawn as parallax layers: sky, far skyline, the set itself, and the near ground.
 *
 * Each layer is its own SVG inside its own composited div, and the static ones are memoised: the camera and the
 * parallax move them with a CSS transform, so Chrome keeps their pixels (blur filters included) instead of painting
 * the whole set again for every frame. Only `SceneFx` (motes, flicker) is drawn per frame. That split is what keeps a
 * scene this rich inside the render-time budget (docs/VOICE_EXPLAINER.md, "Measured").
 */

export const ART_W = 1000;
export const ART_H = 680;
/** The art is drawn on y 0..ART_H; the view adds sky (or wall) above it so the card is tall enough for 9:16. */
export const ART_TOP = -100;
export const VIEW_H = ART_H - ART_TOP;
export const GROUND = 575;
/** Every layer is drawn this much wider on each side, so the parallax drift never shows an edge. */
export const MARGIN = 80;

export type Depth = "sky" | "far" | "mid" | "near" | "fx";
/** How far each layer drifts over a scene, in art units. The ground and the people move together (depth 1). */
export const DRIFT: Record<Depth, number> = { sky: 4, far: 12, mid: 26, near: 44, fx: 52 };

export const Layer: React.FC<{ scale: number; shift: number; children: React.ReactNode }> = ({ scale, shift, children }) => (
  <div
    style={{
      position: "absolute",
      top: 0,
      left: -MARGIN * scale,
      width: (ART_W + 2 * MARGIN) * scale,
      height: VIEW_H * scale,
      transform: `translate3d(${(shift * scale).toFixed(2)}px,0,0)`,
      willChange: "transform",
    }}
  >
    <svg width="100%" height="100%" viewBox={`${-MARGIN} ${ART_TOP} ${ART_W + 2 * MARGIN} ${VIEW_H}`} style={{ display: "block" }}>
      {children}
    </svg>
  </div>
);

/** Shared filters. Ids carry a prefix: several SVGs share one document, and the first `#glow` would win. */
const Defs: React.FC<{ id: string; look: Look }> = ({ id, look }) => (
  <defs>
    <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="10" />
    </filter>
    <filter id={`${id}-soft`} x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="22" />
    </filter>
    <linearGradient id={`${id}-sky`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={look.sky[0]} />
      <stop offset="0.62" stopColor={look.sky[1]} />
      <stop offset="1" stopColor={mix(look.sky[1], look.light, 0.25)} />
    </linearGradient>
    <linearGradient id={`${id}-cone`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={look.light} stopOpacity={0.55 * look.glow} />
      <stop offset="1" stopColor={look.light} stopOpacity="0" />
    </linearGradient>
    <linearGradient id={`${id}-pane`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={mix(look.light, "#ffffff", 0.35)} />
      <stop offset="1" stopColor={mix(look.light, look.near, 0.35)} />
    </linearGradient>
    <linearGradient id={`${id}-ground`} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={mix(look.near, "#000000", 0.35)} />
      <stop offset="1" stopColor={mix(look.near, "#000000", 0.6)} />
    </linearGradient>
    <radialGradient id={`${id}-sun`}>
      <stop offset="0" stopColor={look.light} stopOpacity={0.9 * Math.min(1, look.glow)} />
      <stop offset="0.25" stopColor={look.light} stopOpacity={0.35 * Math.min(1, look.glow)} />
      <stop offset="1" stopColor={look.light} stopOpacity="0" />
    </radialGradient>
  </defs>
);

const L = -MARGIN;
const R = ART_W + MARGIN;

/** Sky, soft clouds, the low sun or moon, and a few stars on a dark look. */
const SkyArt: React.FC<{ id: string; look: Look; horizon: number }> = ({ id, look, horizon }) => {
  const dark = look.glow >= 0.9;
  return (
    <g>
      <rect x={L} y={ART_TOP} width={R - L} height={VIEW_H} fill={`url(#${id}-sky)`} />
      <circle cx={790} cy={horizon - 10} r={220} fill={`url(#${id}-sun)`} />
      <circle cx={790} cy={horizon - 10} r={26} fill={mix(look.light, "#ffffff", 0.4)} opacity={0.85} />
      {[
        [180, 70, 260, 18],
        [620, 110, 330, 22],
        [380, 160, 220, 14],
      ].map(([cx, cy, rx, ry], i) => (
        <ellipse key={i} cx={cx} cy={cy} rx={rx} ry={ry} fill={mix(look.sky[0], look.light, 0.35)} opacity={0.45} filter={`url(#${id}-glow)`} />
      ))}
      {dark
        ? Array.from({ length: 22 }, (_, i) => (
            <circle key={i} cx={L + hash01(i, 11) * (R - L)} cy={ART_TOP + 10 + hash01(i, 12) * ((horizon - ART_TOP) * 0.55)} r={0.8 + hash01(i, 13) * 1.6} fill="#ffffff" opacity={0.25 + hash01(i, 14) * 0.45} />
          ))
        : null}
    </g>
  );
};

/** A distant skyline: blocks of varied height, antennas, a few lit windows. */
const Skyline: React.FC<{ look: Look; base: number; tone: number; seed: number }> = ({ look, base, tone, seed }) => {
  const fill = mix(look.far, look.sky[1], tone);
  const out: React.ReactNode[] = [];
  let x = L;
  for (let i = 0; x < R; i++) {
    const w = 40 + hash01(i, seed) * 70;
    const h = 30 + hash01(i, seed + 1) * 110;
    out.push(<rect key={`b${i}`} x={x} y={base - h} width={w - 3} height={h + 2} fill={fill} />);
    if (hash01(i, seed + 2) > 0.7) out.push(<rect key={`a${i}`} x={x + w / 2} y={base - h - 22} width={3} height={22} fill={fill} />);
    for (let k = 0; k < 4; k++)
      if (hash01(i * 7 + k, seed + 3) > 0.72)
        out.push(
          <rect key={`w${i}-${k}`} x={x + 6 + hash01(i * 5 + k, seed + 4) * (w - 18)} y={base - h + 8 + k * 18} width={5} height={7} fill={look.light} opacity={0.55} />,
        );
    x += w;
  }
  return <g>{out}</g>;
};

// ── street: a café at dusk ───────────────────────────────────────────────

const StreetMid: React.FC<{ id: string; look: Look }> = ({ id, look }) => {
  const wall = mix(look.near, "#000000", 0.28);
  const trim = mix(look.near, "#000000", 0.5);
  const cream = mix("#f4ece0", look.light, 0.15);
  const top = 292;
  const awningY = 372;
  const windows = [-50, 140, 660, 850];
  return (
    <g>
      <rect x={L} y={top} width={R - L} height={GROUND - top} fill={wall} />
      <rect x={L} y={top - 14} width={R - L} height={16} fill={trim} />
      {/* brick courses, faint */}
      {Array.from({ length: 9 }, (_, r) => (
        <line key={r} x1={L} x2={R} y1={top + 8 + r * 9} y2={top + 8 + r * 9} stroke={trim} strokeOpacity={0.25} strokeWidth={1} />
      ))}
      {/* the sign: a cup, so it reads in any language */}
      <rect x={440} y={322} width={120} height={38} rx={8} fill={trim} />
      <g transform="translate(500 341)" stroke={look.light} strokeWidth={3.5} fill="none" strokeLinecap="round">
        <path d="M-14 -8 h22 v8 a11 11 0 0 1 -22 0 z" fill={alpha(look.light, 0.25)} />
        <path d="M8 -4 a6 6 0 0 1 0 10" />
        <path d="M-8 -16 q3 -4 0 -7 M0 -16 q3 -4 0 -7" strokeWidth={2.5} opacity={0.8} />
      </g>
      <rect x={430} y={316} width={140} height={50} rx={12} fill={look.light} opacity={0.18 * look.glow} filter={`url(#${id}-glow)`} />
      {/* window glow first, so it spills onto the wall around the frames */}
      {windows.map((x) => (
        <rect key={`g${x}`} x={x - 10} y={428} width={210} height={150} fill={look.light} opacity={0.45 * look.glow} filter={`url(#${id}-soft)`} />
      ))}
      <rect x={455} y={428} width={90} height={160} fill={look.light} opacity={0.5 * look.glow} filter={`url(#${id}-soft)`} />
      {windows.map((x) => (
        <g key={x}>
          <rect x={x} y={436} width={190} height={128} fill={`url(#${id}-pane)`} />
          {/* shelves and cups inside */}
          <rect x={x} y={500} width={190} height={4} fill={trim} opacity={0.55} />
          {Array.from({ length: 6 }, (_, k) => (
            <rect key={k} x={x + 12 + k * 30} y={482 - (k % 3) * 6} width={12} height={18 + (k % 3) * 6} rx={2} fill={trim} opacity={0.55} />
          ))}
          <circle cx={x + 60} cy={548} r={14} fill={trim} opacity={0.45} />
          <circle cx={x + 132} cy={552} r={11} fill={trim} opacity={0.4} />
          <rect x={x} y={436} width={190} height={128} fill="none" stroke={trim} strokeWidth={8} />
          <line x1={x + 95} y1={436} x2={x + 95} y2={564} stroke={trim} strokeWidth={6} />
        </g>
      ))}
      {/* the door, lit from inside */}
      <rect x={462} y={430} width={76} height={GROUND - 430} fill={mix(look.light, "#ffffff", 0.2)} />
      <rect x={462} y={430} width={76} height={GROUND - 430} fill="none" stroke={trim} strokeWidth={8} />
      <rect x={526} y={500} width={5} height={18} rx={2} fill={trim} />
      {/* the awning: stripes with a scalloped edge */}
      <rect x={L} y={awningY - 10} width={R - L} height={12} fill={trim} />
      {Array.from({ length: Math.ceil((R - L) / 46) }, (_, i) => {
        const x = L + i * 46;
        const c = i % 2 ? cream : look.cast[0];
        return (
          <g key={i}>
            <path d={`M${x} ${awningY} L${x + 46} ${awningY} L${x + 46} ${awningY + 40} A23 14 0 0 1 ${x} ${awningY + 40} Z`} fill={c} />
            <path d={`M${x} ${awningY + 30} L${x + 46} ${awningY + 30} L${x + 46} ${awningY + 40} A23 14 0 0 1 ${x} ${awningY + 40} Z`} fill="#000" opacity={0.12} />
          </g>
        );
      })}
      {/* wall lamps with their cones */}
      {[118, 360, 640, 830].map((x) => (
        <g key={`l${x}`}>
          <polygon points={`${x - 6},${436} ${x + 6},${436} ${x + 60},${GROUND} ${x - 60},${GROUND}`} fill={`url(#${id}-cone)`} opacity={0.6} />
          <circle cx={x} cy={432} r={22} fill={look.light} opacity={0.55 * look.glow} filter={`url(#${id}-glow)`} />
          <rect x={x - 6} y={422} width={12} height={16} rx={4} fill={mix(look.light, "#ffffff", 0.5)} />
        </g>
      ))}
    </g>
  );
};

const StreetNear: React.FC<{ id: string; look: Look }> = ({ id, look }) => (
  <g>
    <rect x={L} y={GROUND} width={R - L} height={ART_H - GROUND} fill={`url(#${id}-ground)`} />
    <rect x={L} y={GROUND} width={R - L} height={6} fill={mix(look.near, "#ffffff", 0.08)} />
    {/* the windows' light on the pavement */}
    {[-50, 140, 455, 660, 850].map((x) => (
      <ellipse key={x} cx={x + 95} cy={GROUND + 30} rx={110} ry={16} fill={look.light} opacity={0.2 * look.glow} filter={`url(#${id}-glow)`} />
    ))}
    <line x1={L} x2={R} y1={ART_H - 34} y2={ART_H - 34} stroke={mix(look.near, "#ffffff", 0.1)} strokeWidth={4} opacity={0.6} />
    {/* a street lamp at the edge, nearest the camera */}
    <g>
      <polygon points={`${1010},${250} ${1030},${250} ${1120},${GROUND + 40} ${920},${GROUND + 40}`} fill={`url(#${id}-cone)`} opacity={0.55} />
      <rect x={1016} y={250} width={8} height={GROUND - 250 + 20} fill={mix(look.near, "#000000", 0.65)} />
      <rect x={1004} y={236} width={32} height={18} rx={6} fill={mix(look.near, "#000000", 0.65)} />
      <circle cx={1020} cy={256} r={30} fill={look.light} opacity={0.6 * look.glow} filter={`url(#${id}-glow)`} />
      <rect x={1010} y={252} width={20} height={8} rx={3} fill={mix(look.light, "#ffffff", 0.6)} />
    </g>
    {/* a plant by the door */}
    <g transform={`translate(${-30} ${GROUND})`}>
      <rect x={-26} y={-44} width={52} height={44} rx={6} fill={mix(look.near, "#000000", 0.45)} />
      {[-1, 0, 1].map((k) => (
        <ellipse key={k} cx={k * 18} cy={-70 - (k === 0 ? 16 : 0)} rx={18} ry={34} fill={mix(look.cast[3], "#1e5a3a", 0.75)} transform={`rotate(${k * 24} ${k * 18} -50)`} />
      ))}
    </g>
  </g>
);

// ── room: a window, a lamp, a shelf ─────────────────────────────────────

const ROOM_WIN = { x: 560, y: 120, w: 320, h: 260 };

const RoomWall: React.FC<{ id: string; look: Look }> = ({ id, look }) => {
  const wall = mix(look.far, look.background2, 0.35);
  const trim = mix(wall, "#000000", 0.35);
  const { x, y, w, h } = ROOM_WIN;
  return (
    <g>
      {/* the wall, with the window cut out so the sky layer behind shows through */}
      <path d={`M${L} ${ART_TOP} H${R} V${GROUND} H${L} Z M${x} ${y} V${y + h} H${x + w} V${y} Z`} fill={wall} fillRule="evenodd" />
      <rect x={L} y={GROUND - 120} width={R - L} height={120} fill={mix(wall, "#000000", 0.12)} />
      <rect x={L} y={GROUND - 124} width={R - L} height={6} fill={trim} opacity={0.6} />
      <rect x={x - 10} y={y - 10} width={w + 20} height={h + 20} fill="none" stroke={trim} strokeWidth={14} />
      <line x1={x + w / 2} y1={y} x2={x + w / 2} y2={y + h} stroke={trim} strokeWidth={9} />
      <line x1={x} y1={y + h / 2} x2={x + w} y2={y + h / 2} stroke={trim} strokeWidth={7} />
      <rect x={x - 24} y={y + h + 6} width={w + 48} height={12} rx={3} fill={trim} />
      {/* curtains */}
      {[x - 52, x + w + 18].map((cx, i) => (
        <g key={i}>
          <rect x={cx} y={y - 30} width={34} height={h + 70} rx={10} fill={mix(look.cast[1], wall, 0.35)} />
          {[8, 18, 27].map((k) => (
            <line key={k} x1={cx + k} y1={y - 26} x2={cx + k} y2={y + h + 36} stroke="#000" strokeOpacity={0.12} strokeWidth={3} />
          ))}
        </g>
      ))}
      <rect x={x - 70} y={y - 40} width={w + 140} height={10} rx={5} fill={trim} />
      {/* a frame and a shelf of books on the left wall */}
      <rect x={70} y={120} width={150} height={110} rx={6} fill={trim} />
      <rect x={80} y={130} width={130} height={90} rx={3} fill={mix(look.sky[1], wall, 0.3)} />
      <path d="M80 210 L125 165 L160 195 L185 175 L210 205 V220 H80 Z" fill={mix(look.cast[2], wall, 0.3)} />
      <rect x={260} y={240} width={190} height={10} rx={3} fill={trim} />
      {[0, 1, 2, 3, 4, 5].map((k) => (
        <rect key={k} x={270 + k * 26} y={192 + (k % 2) * 8} width={20} height={48 - (k % 2) * 8} rx={2} fill={mix(look.cast[k % 4], wall, 0.25)} />
      ))}
      {/* a floor lamp's glow on the wall */}
      <circle cx={140} cy={330} r={70} fill={look.light} opacity={0.35 * look.glow} filter={`url(#${id}-soft)`} />
    </g>
  );
};

const RoomNear: React.FC<{ id: string; look: Look }> = ({ id, look }) => {
  const floor = mix(look.near, "#000000", 0.25);
  const { x, y, w, h } = ROOM_WIN;
  return (
    <g>
      {/* the window's light falling across the floor */}
      <polygon points={`${x},${y + h} ${x + w},${y + h} ${x + w - 120},${ART_H} ${x - 260},${ART_H}`} fill={look.light} opacity={0.1 * look.glow} filter={`url(#${id}-glow)`} />
      <rect x={L} y={GROUND} width={R - L} height={ART_H - GROUND} fill={floor} />
      {Array.from({ length: 14 }, (_, k) => (
        <line key={k} x1={L + k * 90} y1={GROUND} x2={L + k * 90 - 60} y2={ART_H} stroke="#000" strokeOpacity={0.15} strokeWidth={2} />
      ))}
      <polygon points={`${x - 40},${GROUND} ${x + w - 60},${GROUND} ${x + w - 160},${ART_H} ${x - 300},${ART_H}`} fill={look.light} opacity={0.12 * look.glow} />
      <ellipse cx={500} cy={GROUND + 52} rx={330} ry={30} fill={mix(look.cast[0], floor, 0.55)} opacity={0.8} />
      {/* the floor lamp */}
      <g>
        <rect x={136} y={330} width={7} height={GROUND - 330} fill={mix(floor, "#000000", 0.4)} />
        <ellipse cx={140} cy={GROUND} rx={26} ry={6} fill={mix(floor, "#000000", 0.4)} />
        <path d="M112 330 L168 330 L156 292 L124 292 Z" fill={mix(look.light, "#ffffff", 0.3)} />
        <polygon points="112,330 168,330 230,575 50,575" fill={`url(#${id}-cone)`} opacity={0.5} />
      </g>
    </g>
  );
};

// ── office: windows, ceiling lights, desks with monitors ─────────────────

const OFFICE_WINS = [40, 300, 560, 820];

const OfficeWall: React.FC<{ id: string; look: Look }> = ({ id, look }) => {
  const wall = mix(look.far, look.background, 0.25);
  const trim = mix(wall, "#000000", 0.4);
  const holes = OFFICE_WINS.map((x) => `M${x} 70 V330 H${x + 180} V70 Z`).join(" ");
  return (
    <g>
      <path d={`M${L} ${ART_TOP} H${R} V${GROUND} H${L} Z ${holes}`} fill={wall} fillRule="evenodd" />
      {OFFICE_WINS.map((x) => (
        <g key={x}>
          <rect x={x} y={70} width={180} height={260} fill="none" stroke={trim} strokeWidth={10} />
          <line x1={x + 90} y1={70} x2={x + 90} y2={330} stroke={trim} strokeWidth={6} />
        </g>
      ))}
      <rect x={L} y={ART_TOP} width={R - L} height={34 - ART_TOP} fill={trim} />
      {[120, 380, 640, 900].map((x) => (
        <g key={x}>
          <rect x={x - 70} y={34} width={140} height={8} rx={3} fill={mix(look.light, "#ffffff", 0.5)} />
          <ellipse cx={x} cy={46} rx={120} ry={20} fill={look.light} opacity={0.35 * look.glow} filter={`url(#${id}-glow)`} />
        </g>
      ))}
      <rect x={L} y={GROUND - 14} width={R - L} height={14} fill={trim} opacity={0.6} />
    </g>
  );
};

const Monitor: React.FC<{ x: number; y: number; s: number; look: Look; id: string; k: number }> = ({ x, y, s, look, id, k }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    <rect x={-70} y={-40} width={140} height={60} rx={12} fill={look.light} opacity={0.35 * look.glow} filter={`url(#${id}-glow)`} />
    <rect x={-60} y={-80} width={120} height={78} rx={6} fill="#0d0d12" />
    <rect x={-54} y={-74} width={108} height={66} rx={3} fill={mix(look.accent, "#0d0d12", 0.55)} />
    {[0, 1, 2, 3, 4].map((r) => (
      <rect key={r} x={-48} y={-68 + r * 12} width={30 + hash01(r, k) * 60} height={5} rx={2} fill={r % 2 ? look.light : look.accent} opacity={0.75} />
    ))}
    <rect x={-6} y={-2} width={12} height={18} fill="#22222a" />
    <rect x={-26} y={14} width={52} height={6} rx={3} fill="#22222a" />
  </g>
);

const OfficeMid: React.FC<{ id: string; look: Look }> = ({ id, look }) => {
  const desk = mix(look.near, "#000000", 0.2);
  return (
    <g>
      {[120, 420, 720, 1000].map((x, i) => (
        <g key={x}>
          <Monitor x={x} y={452} s={0.75} look={look} id={id} k={i} />
          <rect x={x - 110} y={466} width={220} height={12} rx={4} fill={desk} />
          <rect x={x - 100} y={478} width={8} height={70} fill={mix(desk, "#000000", 0.4)} />
          <rect x={x + 92} y={478} width={8} height={70} fill={mix(desk, "#000000", 0.4)} />
        </g>
      ))}
    </g>
  );
};

const OfficeNear: React.FC<{ id: string; look: Look }> = ({ id, look }) => (
  <g>
    <rect x={L} y={GROUND} width={R - L} height={ART_H - GROUND} fill={`url(#${id}-ground)`} />
    {[120, 420, 720, 1000].map((x) => (
      <ellipse key={x} cx={x} cy={GROUND + 24} rx={130} ry={12} fill={look.light} opacity={0.12 * look.glow} filter={`url(#${id}-glow)`} />
    ))}
    <g transform={`translate(${1040} ${GROUND})`}>
      <rect x={-24} y={-50} width={48} height={50} rx={6} fill={mix(look.near, "#000000", 0.5)} />
      {[-1, 0, 1].map((k) => (
        <ellipse key={k} cx={k * 16} cy={-84 - (k === 0 ? 18 : 0)} rx={16} ry={38} fill={mix(look.cast[3], "#1e5a3a", 0.75)} transform={`rotate(${k * 22} ${k * 16} -60)`} />
      ))}
    </g>
  </g>
);

// ── stage: curtains, a truss, spotlights ────────────────────────────────

const StageBack: React.FC<{ id: string; look: Look }> = ({ id, look }) => {
  const back = mix(look.background, look.far, 0.45);
  const curtain = mix(look.cast[0], "#000000", 0.45);
  return (
    <g>
      <rect x={L} y={ART_TOP} width={R - L} height={VIEW_H} fill={back} />
      <circle cx={500} cy={300} r={320} fill={look.light} opacity={0.12 * look.glow} filter={`url(#${id}-soft)`} />
      {[L, ART_W + MARGIN - 210].map((x, i) => (
        <g key={i}>
          <rect x={x} y={ART_TOP} width={210} height={GROUND - ART_TOP} fill={curtain} />
          {Array.from({ length: 7 }, (_, k) => (
            <rect key={k} x={x + k * 30} y={ART_TOP} width={14} height={GROUND - ART_TOP} fill="#000" opacity={0.18} />
          ))}
        </g>
      ))}
      <rect x={L} y={ART_TOP} width={R - L} height={46 - ART_TOP} fill={mix(curtain, "#000000", 0.2)} />
      {Array.from({ length: Math.ceil((R - L) / 60) }, (_, i) => (
        <path key={i} d={`M${L + i * 60} 46 A30 18 0 0 0 ${L + i * 60 + 60} 46 Z`} fill={mix(curtain, "#000000", 0.2)} />
      ))}
      <rect x={L} y={58} width={R - L} height={8} fill="#1a1a1f" />
      {[260, 500, 740].map((x) => (
        <g key={x}>
          <rect x={x - 16} y={60} width={32} height={26} rx={5} fill="#22222a" />
          <circle cx={x} cy={90} r={22} fill={look.light} opacity={0.7 * Math.min(1, look.glow)} filter={`url(#${id}-glow)`} />
        </g>
      ))}
    </g>
  );
};

const StageMid: React.FC<{ id: string }> = ({ id }) => (
  <g>
    {[
      [260, 330, -1],
      [500, 500, 0],
      [740, 670, 1],
    ].map(([x, to], i) => (
      <polygon key={i} points={`${x - 14},92 ${x + 14},92 ${to + 150},${GROUND + 20} ${to - 150},${GROUND + 20}`} fill={`url(#${id}-cone)`} opacity={i === 1 ? 0.75 : 0.45} />
    ))}
  </g>
);

const StageNear: React.FC<{ id: string; look: Look }> = ({ id, look }) => {
  const floor = mix(look.near, "#000000", 0.35);
  return (
    <g>
      <rect x={L} y={GROUND} width={R - L} height={ART_H - GROUND} fill={floor} />
      {Array.from({ length: 6 }, (_, k) => (
        <line key={k} x1={L} x2={R} y1={GROUND + 10 + k * 17} y2={GROUND + 10 + k * 17} stroke="#000" strokeOpacity={0.18} strokeWidth={2} />
      ))}
      <ellipse cx={500} cy={GROUND + 18} rx={250} ry={30} fill={look.light} opacity={0.35 * look.glow} filter={`url(#${id}-glow)`} />
      {[330, 670].map((x) => (
        <ellipse key={x} cx={x} cy={GROUND + 18} rx={130} ry={18} fill={look.light} opacity={0.18 * look.glow} filter={`url(#${id}-glow)`} />
      ))}
      {Array.from({ length: 9 }, (_, k) => (
        <g key={k}>
          <circle cx={40 + k * 115} cy={ART_H - 10} r={16} fill={look.light} opacity={0.4 * look.glow} filter={`url(#${id}-glow)`} />
          <rect x={30 + k * 115} y={ART_H - 16} width={20} height={10} rx={3} fill={mix(look.light, "#ffffff", 0.4)} />
        </g>
      ))}
    </g>
  );
};

/** The static layers of a setting, by depth. Memoised: their props never change within a scene. */
export const SettingLayer = React.memo<{ setting: Setting; depth: Exclude<Depth, "fx">; look: Look; id: string }>(({ setting, depth, look, id }) => {
  const defs = <Defs id={id} look={look} />;
  let body: React.ReactNode = null;
  if (setting === "street") {
    if (depth === "sky") body = <SkyArt id={id} look={look} horizon={GROUND - 260} />;
    if (depth === "far") body = <Skyline look={look} base={GROUND - 250} tone={0.45} seed={3} />;
    if (depth === "mid") body = <StreetMid id={id} look={look} />;
    if (depth === "near") body = <StreetNear id={id} look={look} />;
  } else if (setting === "room") {
    if (depth === "sky") body = <SkyArt id={id} look={look} horizon={ROOM_WIN.y + ROOM_WIN.h} />;
    if (depth === "far") body = <Skyline look={look} base={ROOM_WIN.y + ROOM_WIN.h} tone={0.35} seed={7} />;
    if (depth === "mid") body = <RoomWall id={id} look={look} />;
    if (depth === "near") body = <RoomNear id={id} look={look} />;
  } else if (setting === "office") {
    if (depth === "sky") body = <SkyArt id={id} look={look} horizon={330} />;
    if (depth === "far") body = <Skyline look={look} base={340} tone={0.3} seed={11} />;
    if (depth === "mid")
      body = (
        <>
          <OfficeWall id={id} look={look} />
          <OfficeMid id={id} look={look} />
        </>
      );
    if (depth === "near") body = <OfficeNear id={id} look={look} />;
  } else {
    if (depth === "sky") body = <StageBack id={id} look={look} />;
    if (depth === "mid") body = <StageMid id={id} />;
    if (depth === "near") body = <StageNear id={id} look={look} />;
  }
  if (!body) return null;
  return (
    <>
      {defs}
      {body}
    </>
  );
});
SettingLayer.displayName = "SettingLayer";

/** Where light falls in each setting, for the motes: (x, top, bottom, spread). */
const MOTE_ZONES: Record<Setting, [number, number, number, number][]> = {
  street: [
    [118, 440, 570, 50],
    [360, 440, 570, 50],
    [640, 440, 570, 50],
    [1020, 260, 600, 80],
  ],
  room: [[620, 300, 640, 180]],
  office: [
    [120, 60, 300, 90],
    [640, 60, 300, 90],
  ],
  stage: [
    [500, 100, 560, 150],
    [300, 120, 560, 90],
    [700, 120, 560, 90],
  ],
};

/** Per-frame details: dust drifting through the light. Deterministic (hash of index), never Math.random. */
export const SceneFx: React.FC<{ setting: Setting; look: Look; t: number }> = ({ setting, look, t }) => {
  const zones = MOTE_ZONES[setting];
  const motes: React.ReactNode[] = [];
  zones.forEach(([x, top, bottom, spread], z) => {
    for (let i = 0; i < 9; i++) {
      const k = z * 31 + i;
      const span = bottom - top;
      const speed = 6 + hash01(k, 1) * 10;
      const y = bottom - ((hash01(k, 2) * span + t * speed) % span);
      const px = x + (hash01(k, 3) - 0.5) * 2 * spread * ((y - top) / span + 0.3) + Math.sin(t * 0.8 + k) * 6;
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(t * (0.6 + hash01(k, 4)) + k));
      motes.push(<circle key={k} cx={px} cy={y} r={1.2 + hash01(k, 5) * 1.8} fill={mix(look.light, "#ffffff", 0.5)} opacity={0.55 * tw * Math.min(1, look.glow + 0.2)} />);
    }
  });
  return <g>{motes}</g>;
};
