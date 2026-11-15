import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { SANS, alpha, mix, type Look } from "./looks";
import { WALK_S, clamp01, easeInOutCubic, easeOutBack, easeOutCubic, eyeOpenness, handover, hash01, mouthOpenness, pushIn, ramp, seedOf, speakerIndex } from "./motion";
import { Grain } from "./Film";
import { ART_W, DRIFT, GROUND, Layer, SceneFx, SettingLayer, VIEW_H } from "./Scenery";
import type { CastMember, Pose, Prop, Setting, Word } from "./types";

/**
 * A setting, up to three people and one prop, drawn in code.
 *
 * Code, not a model: the same scene renders the same pixels every time, costs nothing, and a person cannot come out
 * with six fingers or a different face between two scenes. The look only recolours; the shapes are fixed. A person's
 * hair follows their colour slot, so "the one in red" looks the same in every scene they appear in.
 *
 * Everything moves as a function of the frame (motion.ts): breathing, blinks at seeded moments, a mouth that opens
 * only while the narration's words are being said, eased gestures, a walk-in, and a hand-over when two people share a
 * hand-held prop.
 */

type Pt = [number, number];
const rad = (d: number) => (d * Math.PI) / 180;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** A limb from `from`: angle 0 points straight down, 90 points to `side`, 180 straight up. */
const limb = (from: Pt, side: number, deg: number, len: number): Pt => [from[0] + side * Math.sin(rad(deg)) * len, from[1] + Math.cos(rad(deg)) * len];

/** [upper-arm angle, elbow bend] per arm. */
type Arm = [number, number];
interface Act {
  armL: Arm;
  armR: Arm;
  /** Vertical hop (art units, up is negative). */
  hop: number;
  headTilt: number;
  headDrop: number;
  lean: number;
  brow: number;
  gazeUp: number;
}

const IDLE: Arm = [10, 14];
const UPPER = 50;
const FORE = 48;

const mixArm = (a: Arm, b: Arm, t: number): Arm => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];

/** A pose as motion over the scene's seconds `t`: every gesture eases in from the idle stance, nothing snaps. */
const act = (pose: Pose, t: number, facing: number, seed: number): Act => {
  const e = easeInOutCubic((t - 0.25) / 0.5);
  const fSide = facing >= 0 ? 1 : -1;
  const a: Act = { armL: IDLE, armR: IDLE, hop: 0, headTilt: 0, headDrop: 0, lean: 0, brow: 0, gazeUp: 0 };
  const set = (side: number, arm: Arm) => (side > 0 ? (a.armR = arm) : (a.armL = arm));
  const idleSwing = Math.sin(t * 1.3 + seed) * 2;
  a.armL = [IDLE[0] + idleSwing, IDLE[1]];
  a.armR = [IDLE[0] - idleSwing, IDLE[1]];
  switch (pose) {
    case "wave":
      // Upper arm out and up, the forearm swinging either side of vertical: it never crosses the face.
      set(fSide, mixArm(IDLE, [112, 52 + 22 * Math.sin(t * Math.PI * 4.2)], e));
      a.brow = 3 * e;
      break;
    case "point":
      set(fSide, mixArm(IDLE, [84 + 3 * Math.sin(t * Math.PI * 1.4), 4], e));
      set(-fSide, mixArm(IDLE, [28, 70], e));
      a.brow = 2 * e;
      break;
    case "think":
      set(fSide, mixArm(IDLE, [26, 150], e));
      set(-fSide, mixArm(IDLE, [20, 95], e));
      a.headTilt = -6 * fSide * e;
      a.gazeUp = e;
      a.brow = 2 * e;
      break;
    case "cheer": {
      const b = Math.sin(t * Math.PI * 3.6);
      a.armL = mixArm(IDLE, [158 + 8 * b, 18], e);
      a.armR = mixArm(IDLE, [158 - 8 * b, 18], e);
      a.hop = -Math.abs(Math.sin(t * Math.PI * 1.8)) * 16 * e;
      a.brow = 4 * e;
      break;
    }
    case "sad":
      a.armL = mixArm(IDLE, [4, 4], e);
      a.armR = mixArm(IDLE, [4, 4], e);
      a.headDrop = 9 * e;
      a.headTilt = 7 * fSide * e + Math.sin(t * 0.9) * 1.5;
      a.lean = 3 * e;
      a.brow = -3 * e;
      break;
    case "sit":
      // One forearm on the table they face, the other hand in the lap.
      set(fSide, mixArm(IDLE, [46, 34], e));
      set(-fSide, mixArm(IDLE, [14, -38], e));
      break;
    case "walk":
    case "stand":
    default:
      break;
  }
  return a;
};

/** How long a walk-in takes, and where it starts: from the near edge of the frame, toward the person's place. */
const walkX = (x: number, t: number): { x: number; phase: number; moving: number } => {
  const from = x < ART_W / 2 ? -90 : ART_W + 90;
  const p = clamp01(t / WALK_S);
  const eased = 1 - Math.pow(1 - p, 2.2);
  const pos = lerp(from, x, eased);
  // Steps follow the distance covered, so the feet never slide.
  return { x: pos, phase: Math.abs(pos - from) / 26, moving: p < 1 ? Math.min(1, (1 - p) * 4) : 0 };
};

// Brown, not black: on the dark silhouette faces a black fringe would vanish.
const hairColor = (look: Look) => mix(look.skin, "#7a5634", 0.55);

/** Hair by colour slot: short with a fringe, a cap, a bun, a beanie. */
const Hair: React.FC<{ style: number; hx: number; hy: number; facing: number; look: Look }> = ({ style, hx, hy, facing, look }) => {
  const f = facing >= 0 ? 1 : -1;
  const hair = hairColor(look);
  switch (style % 4) {
    case 0:
      return <path d={`M${hx - 41} ${hy - 4} Q${hx - 44} ${hy - 46} ${hx} ${hy - 46} Q${hx + 44} ${hy - 46} ${hx + 41} ${hy - 4} Q${hx + 22 * f} ${hy - 30} ${hx - 20 * f} ${hy - 22} Z`} fill={hair} />;
    case 1: {
      const cap = look.cast[(style + 1) % 4];
      return (
        <g>
          <path d={`M${hx - 40} ${hy - 12} Q${hx - 40} ${hy - 50} ${hx} ${hy - 50} Q${hx + 40} ${hy - 50} ${hx + 40} ${hy - 12} Z`} fill={cap} />
          <path d={`M${hx + 10 * f} ${hy - 16} L${hx + 66 * f} ${hy - 10} Q${hx + 70 * f} ${hy - 18} ${hx + 36 * f} ${hy - 22} Z`} fill={mix(cap, "#000000", 0.25)} />
          <circle cx={hx} cy={hy - 49} r={4} fill={mix(cap, "#000000", 0.3)} />
        </g>
      );
    }
    case 2:
      return (
        <g>
          <circle cx={hx} cy={hy - 50} r={17} fill={hair} />
          <path d={`M${hx - 41} ${hy} Q${hx - 42} ${hy - 44} ${hx} ${hy - 44} Q${hx + 42} ${hy - 44} ${hx + 41} ${hy} Q${hx + 30} ${hy - 26} ${hx} ${hy - 30} Q${hx - 30} ${hy - 26} ${hx - 41} ${hy} Z`} fill={hair} />
        </g>
      );
    default: {
      const beanie = look.cast[(style + 2) % 4];
      return (
        <g>
          <path d={`M${hx - 41} ${hy - 14} Q${hx - 41} ${hy - 56} ${hx} ${hy - 56} Q${hx + 41} ${hy - 56} ${hx + 41} ${hy - 14} Z`} fill={beanie} />
          <rect x={hx - 43} y={hy - 22} width={86} height={13} rx={6} fill={mix(beanie, "#000000", 0.2)} />
          <circle cx={hx} cy={hy - 58} r={8} fill={mix(beanie, "#ffffff", 0.3)} />
        </g>
      );
    }
  }
};

export interface FigureProps {
  x: number;
  member: CastMember;
  look: Look;
  /** Seconds since the scene started. */
  t: number;
  /** Seconds on the narration clock (for the mouth). */
  clock: number;
  facing: number;
  seed: number;
  talking: boolean;
  words: Word[];
  enter: number;
  /** Arms replaced during a hand-over, by side (-1 left, 1 right). */
  armOverride?: { side: number; arm: Arm; weight: number }[];
  /** 0..1: a little hop of surprise (the receiver of a hand-over). */
  react: number;
  /** Something held in the hand on `side`: drawn at the hand so it follows the gesture. */
  holding?: { side: number; node: (hand: Pt) => React.ReactNode };
}

export const Figure: React.FC<FigureProps> = ({ x: x0, member, look, t, clock, facing, seed, talking, words, enter, armOverride, react, holding }) => {
  const color = look.cast[Math.abs(member.color) % look.cast.length];
  const walking = member.pose === "walk" ? walkX(x0, t) : null;
  const x = walking ? walking.x : x0;
  const a = act(member.pose, t, facing, seed);
  for (const o of armOverride ?? []) {
    if (o.side > 0) a.armR = mixArm(a.armR, o.arm, o.weight);
    else a.armL = mixArm(a.armL, o.arm, o.weight);
  }
  const sit = member.pose === "sit";
  const breathe = Math.sin((t * Math.PI * 2) / 3.4 + seed) * 0.5 + 0.5;
  const hop = a.hop - Math.sin(Math.PI * clamp01(react)) * 18;
  const bob = walking ? -Math.abs(Math.sin(walking.phase * Math.PI)) * 5 * walking.moving : 0;
  const ground = GROUND;
  const hipY = (sit ? ground - 92 : ground - 128) + hop + bob;
  const shoulderY = hipY - 104 - breathe * 2;
  const headY = shoulderY - 50 + a.headDrop;
  const f = facing >= 0 ? 1 : -1;
  const gaze = facing === 0 ? 0 : f;
  const trousers = mix(look.skin, look.far, 0.35);
  const shoe = mix(look.skin, "#000000", 0.3);
  const sleeve = mix(color, "#000000", 0.12);

  // legs: [hip, knee, foot] each
  const legs: [Pt, Pt, Pt][] = [-1, 1].map((side) => {
    const hip: Pt = [x + side * 15, hipY];
    if (sit) {
      const knee: Pt = [x + side * 12 + f * 52, hipY + 4];
      return [hip, knee, [knee[0] + f * 6, ground]];
    }
    if (walking && walking.moving > 0) {
      const swing = Math.sin(walking.phase * Math.PI + (side > 0 ? 0 : Math.PI)) * 24 * walking.moving;
      const knee = limb(hip, f, swing, 64);
      const foot = limb(knee, f, swing - Math.max(0, -swing) * 0.8, 64);
      return [hip, knee, [foot[0], Math.min(ground, foot[1])]];
    }
    const knee: Pt = [x + side * 17, hipY + 64];
    return [hip, knee, [x + side * 20, ground]];
  });

  const shoulder = (side: number): Pt => [x + side * 33, shoulderY + 12];
  const arm = (side: number, [a1, bend]: Arm) => {
    const s = shoulder(side);
    const elbow = limb(s, side, a1, UPPER);
    const hand = limb(elbow, side, a1 + bend, FORE);
    return { s, elbow, hand };
  };
  const L = arm(-1, a.armL);
  const R = arm(1, a.armR);

  const open = eyeOpenness(seed, t);
  const mouth = talking ? mouthOpenness(words, clock) : 0;
  const hx = x + a.headTilt * 0.6;
  const hy = headY;
  const eyeY = hy - 2 - a.gazeUp * 3;
  const browY = hy - 20 - a.brow;
  const browGrey = mix(look.skin, "#ffffff", 0.6);
  const smile = member.pose === "cheer" || member.pose === "wave" ? 1 : member.pose === "sad" ? -1 : 0.4;

  return (
    <g opacity={enter} transform={`translate(0 ${((1 - enter) * 40).toFixed(1)})`}>
      {/* the shadow on the ground shrinks as they hop */}
      <ellipse cx={x} cy={ground + 4} rx={48 + hop * 0.6} ry={9} fill="#000" opacity={0.38} />
      {sit ? (
        <g fill={mix(look.near, "#000000", 0.55)}>
          <rect x={x - 40} y={hipY + 10} width={80} height={10} rx={4} />
          <rect x={x - 36 * f - 4} y={hipY - 70} width={8} height={80} rx={3} />
          <rect x={x - 34} y={hipY + 18} width={6} height={ground - hipY - 18} />
          <rect x={x + 28} y={hipY + 18} width={6} height={ground - hipY - 18} />
        </g>
      ) : null}
      <g transform={`rotate(${a.lean * f} ${x} ${hipY})`}>
        {legs.map(([h, k, ft], i) => (
          <g key={i}>
            <path d={`M${h[0]} ${h[1]} L${k[0]} ${k[1]} L${ft[0]} ${ft[1] - 6}`} stroke={trousers} strokeWidth={20} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <ellipse cx={ft[0] + f * 8} cy={ft[1] - 4} rx={16} ry={7} fill={shoe} />
          </g>
        ))}
        {/* the back arm first, so it passes behind the body */}
        {[f > 0 ? L : R].map((A, i) => (
          <g key={`b${i}`}>
            <path d={`M${A.s[0]} ${A.s[1]} L${A.elbow[0]} ${A.elbow[1]} L${A.hand[0]} ${A.hand[1]}`} stroke={mix(sleeve, "#000000", 0.15)} strokeWidth={17} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <circle cx={A.hand[0]} cy={A.hand[1]} r={9} fill={look.skin} />
          </g>
        ))}
        {/* torso: a hoodie with shoulders, breathing */}
        <g transform={`translate(${x} ${hipY}) scale(1 ${(1 + breathe * 0.015).toFixed(4)}) translate(${-x} ${-hipY})`}>
          <path
            d={`M${x - 36} ${shoulderY + 14} Q${x - 40} ${shoulderY - 2} ${x - 22} ${shoulderY - 4} L${x + 22} ${shoulderY - 4} Q${x + 40} ${shoulderY - 2} ${x + 36} ${shoulderY + 14} L${x + 31} ${hipY + 6} Q${x} ${hipY + 13} ${x - 31} ${hipY + 6} Z`}
            fill={color}
          />
          <path d={`M${x + 2 * f} ${shoulderY - 4} L${x + 36 * f} ${shoulderY + 14} L${x + 31 * f} ${hipY + 6} Q${x + 16 * f} ${hipY + 11} ${x + 2 * f} ${hipY + 12} Z`} fill="#000" opacity={0.12} />
          <path d={`M${x - 16} ${shoulderY - 3} Q${x} ${shoulderY + 22} ${x + 16} ${shoulderY - 3}`} fill={mix(color, "#000000", 0.3)} />
          <path d={`M${x - 20} ${hipY - 30} h40`} stroke="#000" strokeOpacity={0.15} strokeWidth={3} />
        </g>
        <rect x={x - 9} y={shoulderY - 16} width={18} height={16} fill={look.skin} />
        {/* the head, turned and tilted toward whoever they face */}
        <g transform={`rotate(${(a.headTilt + gaze * 4 * enter).toFixed(2)} ${x} ${shoulderY - 6})`}>
          <circle cx={hx} cy={hy} r={40} fill={look.skin} />
          <Hair style={Math.abs(member.color)} hx={hx} hy={hy} facing={f} look={look} />
          {[-1, 1].map((s) => (
            <g key={s}>
              <ellipse cx={hx + s * 14 + gaze * 7} cy={eyeY} rx={9} ry={Math.max(0.8, 11 * open)} fill="#fff" />
              {open > 0.3 ? <circle cx={hx + s * 14 + gaze * 10} cy={eyeY + 1 - a.gazeUp * 3} r={4.6} fill="#121216" /> : null}
              <path
                d={`M${hx + s * 14 + gaze * 7 - 8} ${browY + (member.pose === "sad" ? -s * f * 3 : 0)} L${hx + s * 14 + gaze * 7 + 8} ${browY + (member.pose === "sad" ? s * f * 3 : member.pose === "think" && s === f ? -4 : 0)}`}
                stroke={browGrey}
                strokeWidth={3.5}
                strokeLinecap="round"
              />
            </g>
          ))}
          {mouth > 0.02 ? (
            <ellipse cx={hx + gaze * 6} cy={hy + 19} rx={7.5} ry={1.5 + mouth * 8} fill="#5a1520" stroke={browGrey} strokeWidth={2.2} />
          ) : (
            <path d={`M${hx + gaze * 6 - 9} ${hy + 18} Q${hx + gaze * 6} ${hy + 18 + smile * 7} ${hx + gaze * 6 + 9} ${hy + 18}`} stroke={browGrey} strokeWidth={3} strokeLinecap="round" fill="none" />
          )}
        </g>
        {/* the front arm */}
        {[f > 0 ? R : L].map((A, i) => (
          <g key={`f${i}`}>
            <path d={`M${A.s[0]} ${A.s[1]} L${A.elbow[0]} ${A.elbow[1]} L${A.hand[0]} ${A.hand[1]}`} stroke={sleeve} strokeWidth={17} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            <circle cx={A.hand[0]} cy={A.hand[1]} r={9} fill={look.skin} />
          </g>
        ))}
        {holding ? holding.node((holding.side > 0 ? R : L).hand) : null}
        {member.pose === "think" ? <ThoughtBubble x={hx + f * 62} y={hy - 70} t={t} look={look} /> : null}
      </g>
    </g>
  );
};

const ThoughtBubble: React.FC<{ x: number; y: number; t: number; look: Look }> = ({ x, y, t, look }) => {
  const k = (i: number) => easeOutBack((t - 0.6 - i * 0.18) / 0.35);
  const fill = mix("#ffffff", look.light, 0.15);
  return (
    <g>
      <circle cx={x - 18} cy={y + 34} r={6 * k(0)} fill={fill} />
      <circle cx={x - 4} cy={y + 14} r={10 * k(1)} fill={fill} />
      <g transform={`translate(${x + 30} ${y - 26}) scale(${k(2)})`}>
        <ellipse rx={46} ry={30} fill={fill} />
        {[0, 1, 2].map((d) => (
          <circle key={d} cx={-18 + d * 18} cy={0} r={5} fill={mix(look.skin, "#ffffff", 0.2)} opacity={0.35 + 0.65 * Math.abs(Math.sin(t * 3 - d * 0.7))} />
        ))}
      </g>
    </g>
  );
};

// ── props ─────────────────────────────────────────────────────────────────

const PhoneArt: React.FC<{ at: Pt; look: Look; s?: number; glow?: boolean }> = ({ at, look, s = 1, glow = true }) => (
  <g transform={`translate(${at[0]} ${at[1]}) scale(${s})`}>
    {glow ? <circle r={34} fill={look.accent} opacity={0.25 * Math.min(1, look.glow + 0.3)} /> : null}
    <rect x={-13} y={-24} width={26} height={46} rx={5} fill="#111116" stroke={mix(look.accent, "#ffffff", 0.2)} strokeWidth={2} />
    <rect x={-10} y={-19} width={20} height={34} rx={2} fill={look.accent} opacity={0.8} />
  </g>
);

const CoinArt: React.FC<{ at: Pt; spin: number; s?: number }> = ({ at, spin, s = 1 }) => {
  const w = Math.abs(Math.cos(spin)) * 0.85 + 0.15;
  return (
    <g transform={`translate(${at[0]} ${at[1]}) scale(${s})`}>
      <ellipse rx={22 * w} ry={22} fill="#f2b134" stroke="#c98a12" strokeWidth={4} />
      {w > 0.45 ? (
        <text textAnchor="middle" y={8} fontSize={22} fontWeight={800} fill="#8a5a00" fontFamily={SANS} transform={`scale(${w} 1)`}>
          $
        </text>
      ) : null}
    </g>
  );
};

const BookArt: React.FC<{ at: Pt; look: Look; s?: number }> = ({ at, look, s = 1 }) => (
  <g transform={`translate(${at[0]} ${at[1]}) scale(${s})`}>
    <rect x={-26} y={-18} width={25} height={34} rx={3} fill={look.cast[1]} />
    <rect x={1} y={-18} width={25} height={34} rx={3} fill={look.cast[2]} />
    <rect x={-2} y={-18} width={4} height={34} fill="#000" opacity={0.25} />
  </g>
);

/** A laptop on a small table, its screen lighting the air. */
const LaptopDesk: React.FC<{ x: number; look: Look; t: number }> = ({ x, look, t }) => {
  const top = GROUND - 140;
  return (
    <g>
      <rect x={x - 70} y={top} width={140} height={10} rx={4} fill={mix(look.near, "#000000", 0.5)} />
      <rect x={x - 60} y={top + 10} width={8} height={GROUND - top - 10} fill={mix(look.near, "#000000", 0.6)} />
      <rect x={x + 52} y={top + 10} width={8} height={GROUND - top - 10} fill={mix(look.near, "#000000", 0.6)} />
      <ellipse cx={x} cy={top - 34} rx={70} ry={44} fill={look.light} opacity={(0.18 + 0.05 * Math.sin(t * 2.2)) * Math.min(1, look.glow + 0.3)} />
      <path d={`M${x - 46} ${top} L${x - 40} ${top - 62} L${x + 40} ${top - 62} L${x + 46} ${top} Z`} fill="#1c1c22" />
      <rect x={x - 36} y={top - 57} width={72} height={48} rx={3} fill={mix(look.light, look.accent, 0.3)} opacity={0.85} />
      {[0, 1, 2].map((r) => (
        <rect key={r} x={x - 30} y={top - 50 + r * 12} width={30 + ((r * 17 + Math.floor(t * 2)) % 30)} height={5} rx={2} fill="#1c1c22" opacity={0.5} />
      ))}
      <rect x={x - 54} y={top - 4} width={108} height={6} rx={3} fill="#2a2a32" />
    </g>
  );
};

/** A board whose bars grow, the last one in the "good" colour. */
const ChartBoard: React.FC<{ x: number; look: Look; t: number }> = ({ x, look, t }) => {
  const top = GROUND - 330;
  return (
    <g>
      <rect x={x - 6} y={top + 200} width={12} height={GROUND - top - 200} fill={mix(look.near, "#000000", 0.6)} />
      <rect x={x - 110} y={top} width={220} height={210} rx={10} fill={mix("#ffffff", look.panel, 0.15)} stroke={mix(look.near, "#000000", 0.5)} strokeWidth={6} />
      {[40, 70, 55, 110, 150].map((h, i) => {
        const g = easeOutBack((t - 0.4 - i * 0.18) / 0.5);
        const hh = h * Math.max(0, g);
        return <rect key={i} x={x - 90 + i * 37} y={top + 190 - hh} width={26} height={hh} rx={4} fill={i === 4 ? look.good : look.accent} />;
      })}
      <path
        d={`M${x - 77} ${top + 140} L${x - 40} ${top + 115} L${x - 3} ${top + 128} L${x + 34} ${top + 80} L${x + 71} ${top + 40}`}
        stroke={look.bad}
        strokeWidth={4}
        fill="none"
        strokeDasharray={220}
        strokeDashoffset={220 * (1 - easeOutCubic((t - 1.2) / 0.8))}
        strokeLinecap="round"
      />
    </g>
  );
};

const HANDHELD: Prop[] = ["phone", "coin", "book"];

const handheld = (prop: Prop, look: Look, t: number) => (hand: Pt): React.ReactNode => {
  const at: Pt = [hand[0], hand[1] - 14];
  if (prop === "phone") return <PhoneArt at={at} look={look} />;
  if (prop === "coin") return <CoinArt at={at} spin={t * 4} />;
  if (prop === "book") return <BookArt at={at} look={look} />;
  return null;
};

// ── the scene ─────────────────────────────────────────────────────────────

export const CharacterScene: React.FC<{
  sceneId: string;
  setting: Setting;
  cast: CastMember[];
  prop: Prop;
  look: Look;
  width: number;
  words: Word[];
  sceneStart: number;
  durationFrames: number;
}> = ({ sceneId, setting, cast, prop, look, width, words, sceneStart, durationFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const clock = sceneStart + t;
  const seconds = durationFrames / fps;
  const scale = width / ART_W;
  const height = Math.round(VIEW_H * scale);
  const progress = frame / Math.max(1, durationFrames);
  const drift = easeInOutCubic(progress);
  const zoom = pushIn(frame, durationFrames);
  const members = cast.slice(0, 3);
  const n = members.length;
  const xs = n === 1 ? [ART_W * 0.42] : n === 2 ? [ART_W * 0.3, ART_W * 0.7] : [ART_W * 0.22, ART_W * 0.5, ART_W * 0.78];
  const seed = seedOf(sceneId);
  const talker = speakerIndex(members.map((m) => m.pose));
  const id = `s${seed.toString(36)}`;

  const handsOver = n >= 2 && HANDHELD.includes(prop);
  const ho = handover(seconds, members[0]?.pose === "walk" || members[1]?.pose === "walk");
  const travel = handsOver ? clamp01((t - ho.travel) / (ho.land - ho.travel)) : 0;
  const reach = handsOver ? ramp(frame, ho.reach * fps, 0.35 * fps, easeInOutCubic) * (1 - ramp(frame, ho.land * fps, 0.45 * fps, easeInOutCubic)) : 0;
  const receive = handsOver ? ramp(frame, (ho.reach + 0.15) * fps, 0.35 * fps, easeInOutCubic) : 0;
  const settle = handsOver ? ramp(frame, ho.land * fps, 0.4 * fps, easeInOutCubic) : 0;

  const facingOf = (i: number) => {
    if (n === 1) return prop === "none" ? 0 : 1;
    const others = xs.filter((_, k) => k !== i);
    const nearest = others.reduce((b, o) => (Math.abs(o - xs[i]) < Math.abs(b - xs[i]) ? o : b), others[0]);
    return Math.sign(nearest - xs[i]) || 1;
  };

  const figures = members.map((m, i) => {
    const facing = facingOf(i);
    const enter = ramp(frame, 4 + i * 5, 14);
    const fSide = facing >= 0 ? 1 : -1;
    let armOverride: FigureProps["armOverride"];
    let holding: FigureProps["holding"];
    let react = 0;
    if (handsOver && i === 0) {
      armOverride = [{ side: fSide, arm: [72, 6], weight: reach }];
      if (travel <= 0) holding = { side: fSide, node: handheld(prop, look, t) };
    } else if (handsOver && i === 1) {
      armOverride = [{ side: fSide, arm: settle > 0 ? [28, 100] : [66, 8], weight: settle > 0 ? settle : receive }];
      if (travel >= 1) holding = { side: fSide, node: handheld(prop, look, t) };
      react = clamp01((t - ho.land) / 0.5);
      react = react > 0 && react < 1 ? react : 0;
    } else if (!handsOver && n === 1 && HANDHELD.includes(prop)) {
      // One person: they hold it up and look at it.
      armOverride = [{ side: fSide, arm: prop === "coin" ? [44, 56] : [30, 108], weight: ramp(frame, 0.3 * fps, 0.5 * fps, easeInOutCubic) }];
      holding = { side: fSide, node: prop === "coin" ? (h: Pt) => <CoinArt at={[h[0], h[1] - 40 - Math.abs(Math.sin(t * 2.4)) * 30]} spin={t * 5} s={1.3} /> : handheld(prop, look, t) };
    }
    return (
      <Figure
        key={i}
        x={xs[i]}
        member={m}
        look={look}
        t={t}
        clock={clock}
        facing={facing}
        seed={seed + i * 977}
        talking={i === talker}
        words={words}
        enter={enter}
        armOverride={armOverride}
        react={react}
        holding={holding}
      />
    );
  });

  // The prop in flight between two hands, on an arc.
  let flying: React.ReactNode = null;
  if (handsOver && travel > 0 && travel < 1) {
    // Where the giver's and the receiver's hands are at the reach (the arm angles above), so the hand-off has no jump.
    const a: Pt = [xs[0] + 125, GROUND - 205];
    const b: Pt = [xs[1] - 122, GROUND - 195];
    const p = easeInOutCubic(travel);
    const at: Pt = [lerp(a[0], b[0], p), lerp(a[1], b[1], p) - Math.sin(Math.PI * p) * 70];
    flying = handheld(prop, look, t)(at);
  }
  const furniture =
    prop === "laptop" ? <LaptopDesk x={n === 1 ? ART_W * 0.7 : ART_W / 2} look={look} t={t} /> : prop === "chart" ? <ChartBoard x={n === 1 ? ART_W * 0.72 : ART_W / 2} look={look} t={t} /> : null;
  const sitter = members.findIndex((m) => m.pose === "sit");
  const tableX = sitter >= 0 ? xs[sitter] + (facingOf(sitter) >= 0 ? 1 : -1) * 105 : 0;
  const cafeTable =
    sitter >= 0 && prop !== "laptop" ? (
      <g>
        <ellipse cx={tableX} cy={GROUND + 2} rx={40} ry={7} fill="#000" opacity={0.3} />
        <rect x={tableX - 48} y={GROUND - 112} width={96} height={9} rx={4} fill={mix(look.near, "#ffffff", 0.18)} />
        <rect x={tableX - 48} y={GROUND - 104} width={96} height={4} fill="#000" opacity={0.3} />
        <rect x={tableX - 4} y={GROUND - 104} width={8} height={104} fill={mix(look.near, "#000000", 0.5)} />
        <rect x={tableX - 22} y={GROUND - 5} width={44} height={5} rx={2} fill={mix(look.near, "#000000", 0.5)} />
        <path d={`M${tableX + 8} ${GROUND - 130} h18 v10 a9 9 0 0 1 -18 0 z`} fill="#f4ece0" />
        <path d={`M${tableX + 26} ${GROUND - 127} a5 5 0 0 1 0 8`} stroke="#f4ece0" strokeWidth={2.5} fill="none" />
        <path d={`M${tableX + 13} ${GROUND - 136} q3 -5 0 -9 M${tableX + 20} ${GROUND - 136} q3 -5 0 -9`} stroke="#f4ece0" strokeWidth={2} opacity={0.35 + 0.3 * Math.sin(t * 2)} fill="none" />
      </g>
    ) : null;
  const confetti =
    setting === "stage" && members.some((m) => m.pose === "cheer")
      ? Array.from({ length: 36 }, (_, k) => {
          const fall = 60 + hash01(k, 21) * 90;
          const y = ((hash01(k, 22) * 700 + t * fall) % 700) - 40;
          const x = hash01(k, 23) * ART_W + Math.sin(t * 2 + k) * 14;
          return <rect key={k} x={x} y={y} width={8} height={14} rx={2} fill={look.cast[k % 4]} transform={`rotate(${(t * 140 + k * 40) % 360} ${x + 4} ${y + 7})`} opacity={0.9 * ramp(frame, 0.6 * fps, 0.5 * fps)} />;
        })
      : null;

  const shift = (d: keyof typeof DRIFT) => DRIFT[d] * (0.5 - drift);
  return (
    <div style={{ position: "relative", width, height, overflow: "hidden", background: look.sky[0] }}>
      <div style={{ position: "absolute", inset: 0, transform: `scale(${zoom.toFixed(4)})`, transformOrigin: "50% 62%", willChange: "transform" }}>
        <Layer scale={scale} shift={shift("sky")}>
          <SettingLayer setting={setting} depth="sky" look={look} id={`${id}a`} />
        </Layer>
        <Layer scale={scale} shift={shift("far")}>
          <SettingLayer setting={setting} depth="far" look={look} id={`${id}b`} />
        </Layer>
        <Layer scale={scale} shift={shift("mid")}>
          <SettingLayer setting={setting} depth="mid" look={look} id={`${id}c`} />
        </Layer>
        <Layer scale={scale} shift={shift("near")}>
          <SettingLayer setting={setting} depth="near" look={look} id={`${id}d`} />
        </Layer>
        <Layer scale={scale} shift={shift("near")}>
          {furniture}
          {cafeTable}
          {figures}
          {flying}
        </Layer>
        <Layer scale={scale} shift={shift("fx")}>
          <SceneFx setting={setting} look={look} t={t} />
          {confetti}
        </Layer>
      </div>
      <Grain look={look} frame={frame} />
      {/* a soft vignette pulls the eye to the middle */}
      <div style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 75% 70% at 50% 55%, transparent 55%, ${alpha("#000000", 0.45)} 100%)` }} />
    </div>
  );
};
