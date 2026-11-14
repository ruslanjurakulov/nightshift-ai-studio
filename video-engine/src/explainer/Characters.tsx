import React from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { Look } from "./looks";
import type { CastMember, Pose, Prop, Setting } from "./types";

/**
 * Flat 2D scenes drawn in code: a setting, up to three figures, one prop.
 *
 * Code, not a model: the same scene renders the same pixels every time, costs nothing, and
 * a figure cannot come out with six fingers or the wrong face between two scenes. The look
 * only recolours; the shapes are fixed.
 */

const W = 1000;
const H = 620;
const GROUND = 520;

const Building: React.FC<{ x: number; w: number; h: number; look: Look; lit: number; frame: number }> = ({ x, w, h, look, lit, frame }) => {
  const cols = Math.max(2, Math.floor(w / 46));
  const rows = Math.max(2, Math.floor(h / 70));
  const cells = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const on = ((r * 7 + c * 13 + lit) % 5 !== 0) !== (Math.floor(frame / 45 + r + c) % 17 === 0);
      cells.push(
        <rect key={`${r}-${c}`} x={x + 14 + c * (w - 20) / cols} y={GROUND - h + 22 + r * 66} width={(w - 20) / cols - 16} height={34} rx={4} fill={on ? look.light : look.far} opacity={on ? 0.85 : 0.6} />,
      );
    }
  return (
    <g>
      <rect x={x} y={GROUND - h} width={w} height={h} fill={look.near} />
      {cells}
    </g>
  );
};

const SettingArt: React.FC<{ setting: Setting; look: Look; frame: number }> = ({ setting, look, frame }) => {
  const sky = (
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={look.sky[0]} />
        <stop offset="1" stopColor={look.sky[1]} />
      </linearGradient>
      <radialGradient id="spot" cx="0.5" cy="0" r="0.9">
        <stop offset="0" stopColor={look.light} stopOpacity="0.55" />
        <stop offset="1" stopColor={look.light} stopOpacity="0" />
      </radialGradient>
    </defs>
  );
  if (setting === "street")
    return (
      <g>
        {sky}
        <rect width={W} height={H} fill="url(#sky)" />
        <rect x={0} y={GROUND - 260} width={W} height={260} fill={look.far} opacity={0.7} />
        <Building x={20} w={260} h={330} look={look} lit={1} frame={frame} />
        <Building x={300} w={400} h={270} look={look} lit={3} frame={frame} />
        <Building x={720} w={260} h={360} look={look} lit={2} frame={frame} />
        {/* an awning over the middle shop */}
        {Array.from({ length: 10 }, (_, i) => (
          <rect key={i} x={300 + i * 40} y={GROUND - 290} width={40} height={36} fill={i % 2 ? "#f2f1ee" : look.cast[0]} />
        ))}
        <rect x={0} y={GROUND} width={W} height={H - GROUND} fill={look.far} />
      </g>
    );
  if (setting === "room")
    return (
      <g>
        {sky}
        <rect width={W} height={H} fill={look.far} />
        <rect x={600} y={90} width={300} height={260} rx={10} fill="url(#sky)" stroke={look.near} strokeWidth={14} />
        <line x1={750} y1={90} x2={750} y2={350} stroke={look.near} strokeWidth={10} />
        <rect x={80} y={120} width={180} height={120} rx={8} fill={look.near} opacity={0.6} />
        <rect x={0} y={GROUND} width={W} height={H - GROUND} fill={look.near} />
      </g>
    );
  if (setting === "office")
    return (
      <g>
        {sky}
        <rect width={W} height={H} fill={look.far} />
        {Array.from({ length: 5 }, (_, i) => (
          <rect key={i} x={60 + i * 190} y={70} width={150} height={190} rx={6} fill="url(#sky)" opacity={0.75} />
        ))}
        <rect x={560} y={GROUND - 120} width={380} height={24} rx={6} fill={look.near} />
        <rect x={640} y={GROUND - 250} width={220} height={130} rx={10} fill="#111" stroke={look.near} strokeWidth={8} />
        <rect x={655} y={GROUND - 237} width={190} height={104} rx={4} fill={look.light} opacity={0.35 + 0.15 * Math.sin(frame / 10)} />
        <rect x={0} y={GROUND} width={W} height={H - GROUND} fill={look.near} />
      </g>
    );
  return (
    <g>
      {sky}
      <rect width={W} height={H} fill={look.far} />
      <polygon points={`${W / 2 - 60},0 ${W / 2 + 60},0 ${W / 2 + 330},${GROUND} ${W / 2 - 330},${GROUND}`} fill="url(#spot)" />
      <rect x={0} y={GROUND} width={W} height={H - GROUND} fill={look.near} />
      <ellipse cx={W / 2} cy={GROUND + 10} rx={300} ry={26} fill={look.light} opacity={0.25} />
    </g>
  );
};

/** Arm angles (degrees from straight down) for [left, right], and whether the figure sits. */
const POSES: Record<Pose, { arms: [number, number]; sit?: boolean; lean?: number }> = {
  stand: { arms: [12, -12] },
  wave: { arms: [12, -150] },
  point: { arms: [12, -95] },
  think: { arms: [12, -140] },
  cheer: { arms: [150, -150] },
  sad: { arms: [5, -5], lean: 6 },
  sit: { arms: [40, -40], sit: true },
};

const Figure: React.FC<{ x: number; member: CastMember; look: Look; frame: number; delay: number }> = ({ x, member, look, frame, delay }) => {
  const { fps } = useVideoConfig();
  const pose = POSES[member.pose] ?? POSES.stand;
  const color = look.cast[Math.abs(member.color) % look.cast.length];
  const enter = spring({ frame: frame - delay, fps, config: { damping: 14 } });
  const bob = Math.sin((frame + delay * 3) / 9) * 3;
  const wave = member.pose === "wave" || member.pose === "cheer" ? Math.sin(frame / 4) * 18 : 0;
  const sit = pose.sit ? 70 : 0;
  const hip = GROUND - 120 + sit;
  const shoulder = hip - 120;
  const headY = shoulder - 48 + bob;
  const arm = (side: -1 | 1, deg: number) => {
    const a = ((deg + (side === 1 ? wave : 0)) * Math.PI) / 180;
    const len = 92;
    return <line x1={x + side * 26} y1={shoulder + 10} x2={x + side * 26 + Math.sin(a) * len * -side} y2={shoulder + 10 + Math.cos(a) * len} stroke={look.skin} strokeWidth={16} strokeLinecap="round" />;
  };
  return (
    <g opacity={enter} transform={`translate(0 ${(1 - enter) * 60}) rotate(${pose.lean ?? 0} ${x} ${hip})`}>
      {/* legs */}
      {pose.sit ? (
        <>
          <rect x={x - 70} y={hip + 20} width={140} height={20} rx={6} fill={look.near} />
          <line x1={x - 14} y1={hip} x2={x + 50} y2={hip + 4} stroke={look.skin} strokeWidth={18} strokeLinecap="round" />
          <line x1={x + 50} y1={hip + 4} x2={x + 50} y2={GROUND} stroke={look.skin} strokeWidth={18} strokeLinecap="round" />
        </>
      ) : (
        <>
          <line x1={x - 14} y1={hip} x2={x - 22} y2={GROUND} stroke={look.skin} strokeWidth={18} strokeLinecap="round" />
          <line x1={x + 14} y1={hip} x2={x + 22} y2={GROUND} stroke={look.skin} strokeWidth={18} strokeLinecap="round" />
        </>
      )}
      {arm(-1, pose.arms[0])}
      {arm(1, -pose.arms[1])}
      <rect x={x - 34} y={shoulder} width={68} height={hip - shoulder + 10} rx={22} fill={color} />
      <circle cx={x} cy={headY} r={38} fill={look.skin} />
      {/* eyes face the middle of the frame */}
      <circle cx={x + (x < W / 2 ? 10 : -10)} cy={headY - 6} r={5} fill="#fff" />
      <circle cx={x + (x < W / 2 ? 24 : -24)} cy={headY - 6} r={5} fill="#fff" />
      {member.pose === "sad" ? <path d={`M${x - 10} ${headY + 18} q10 -8 20 0`} stroke="#fff" strokeWidth={4} fill="none" /> : null}
      {member.pose === "cheer" ? <path d={`M${x - 12} ${headY + 12} q12 12 24 0`} stroke="#fff" strokeWidth={4} fill="none" /> : null}
      {member.pose === "think" ? (
        <g opacity={0.9}>
          <circle cx={x + 60} cy={headY - 60} r={10} fill="#fff" />
          <circle cx={x + 84} cy={headY - 92} r={16} fill="#fff" />
        </g>
      ) : null}
    </g>
  );
};

const PropArt: React.FC<{ prop: Prop; x: number; look: Look; frame: number }> = ({ prop, x, look, frame }) => {
  const y = GROUND - 150;
  const pulse = 1 + 0.06 * Math.sin(frame / 6);
  switch (prop) {
    case "laptop":
      return (
        <g transform={`translate(${x} ${GROUND - 110})`}>
          <rect x={-70} y={-90} width={140} height={90} rx={8} fill="#222" stroke="#555" strokeWidth={4} />
          <rect x={-60} y={-80} width={120} height={70} fill={look.light} opacity={0.5 + 0.2 * Math.sin(frame / 8)} />
          <rect x={-90} y={0} width={180} height={12} rx={4} fill="#444" />
        </g>
      );
    case "phone":
      return (
        <g transform={`translate(${x} ${y}) scale(${pulse})`}>
          <rect x={-34} y={-60} width={68} height={120} rx={12} fill="#111" stroke={look.accent} strokeWidth={4} />
          <rect x={-26} y={-48} width={52} height={92} rx={4} fill={look.accent} opacity={0.35} />
        </g>
      );
    case "coin":
      return (
        <g transform={`translate(${x} ${y - 40 + Math.sin(frame / 7) * 10})`}>
          <ellipse rx={46 * Math.abs(Math.cos(frame / 12)) + 6} ry={46} fill="#f2b134" stroke="#c98a12" strokeWidth={6} />
          <text textAnchor="middle" y={16} fontSize={44} fontWeight={800} fill="#8a5a00" fontFamily="Inter, 'DejaVu Sans', sans-serif">
            $
          </text>
        </g>
      );
    case "chart":
      return (
        <g transform={`translate(${x - 80} ${y + 40})`}>
          {[40, 70, 55, 110, 150].map((h, i) => (
            <rect key={i} x={i * 34} y={-Math.min(h, (h * Math.min(frame, 40)) / 40)} width={24} height={Math.min(h, (h * Math.min(frame, 40)) / 40)} rx={4} fill={i === 4 ? look.good : look.accent} />
          ))}
        </g>
      );
    case "book":
      return (
        <g transform={`translate(${x} ${y + 20})`}>
          <rect x={-60} y={-40} width={58} height={80} rx={6} fill={look.cast[1]} />
          <rect x={2} y={-40} width={58} height={80} rx={6} fill={look.cast[2]} />
        </g>
      );
    default:
      return null;
  }
};

export const CharacterScene: React.FC<{ setting: Setting; cast: CastMember[]; prop: Prop; look: Look; width: number }> = ({ setting, cast, prop, look, width }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18 } });
  const members = cast.slice(0, 3);
  const xs = members.length === 1 ? [W / 2] : members.length === 2 ? [W * 0.36, W * 0.64] : [W * 0.25, W * 0.5, W * 0.75];
  const height = Math.round((width * H) / W);
  return (
    <div style={{ width, height, borderRadius: 26, overflow: "hidden", opacity: enter, transform: `scale(${0.95 + 0.05 * enter})`, boxShadow: "0 30px 80px rgba(0,0,0,0.4)" }}>
      <svg width={width} height={height} viewBox={`0 0 ${W} ${H}`}>
        <SettingArt setting={setting} look={look} frame={frame} />
        {members.map((m, i) => (
          <Figure key={i} x={xs[i]} member={m} look={look} frame={frame} delay={4 + i * 5} />
        ))}
        {prop !== "none" ? <PropArt prop={prop} x={members.length === 1 ? W * 0.78 : W / 2} look={look} frame={frame} /> : null}
      </svg>
    </div>
  );
};
