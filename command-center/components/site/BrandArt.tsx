import { useId } from "react";

/**
 * Drawn art made from the site's own stage tokens (the dark panel, the lit amber, the hairlines), for the places that
 * would otherwise show a still a second time or a recoloured copy of one. It is vector, a few hundred bytes, the same in
 * the light and the dark theme (the stage is dark in both), and decorative: every drawing is `aria-hidden`, and what it
 * stands for is said in text beside it. `still` keeps it from moving at all (the auth pages, where the flow card is the only motion). Where it moves (the dashes, the playhead, the glow, the pulses) it moves in CSS
 * only, after the page has loaded, stops with the page's pause switch and does not move under reduced motion
 * (site-next.css, ".nx-art-*").
 *
 * - dawn: a lamp rising over a horizon with rings around it. The sign-in stage.
 * - rundown: the four tracks of a video and a playhead on its way to the approval lamp. The sign-up stage.
 * - tools: Nightshift in the middle and what an assistant can reach around it. The /mcp card.
 */
export type BrandArtKind = "dawn" | "rundown" | "tools";

const AMBER = "var(--nx-stage-amber)";
const STAGE = "var(--nx-stage)";
const STAGE2 = "var(--nx-stage-2)";
const STAGE3 = "var(--nx-stage-3)";
const DIM = "var(--nx-stage-dim)";

export function BrandArt({ kind, className = "", still = false }: { kind: BrandArtKind; className?: string; still?: boolean }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const glow = `g${uid}`;
  const sky = `s${uid}`;
  return (
    <svg className={`nx-art-svg ${className}`.trim()} data-art={kind} data-static={still ? "true" : undefined} viewBox="0 0 640 400" preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false">
      <defs>
        <radialGradient id={glow} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor={AMBER} stopOpacity="0.55" />
          <stop offset="0.45" stopColor={AMBER} stopOpacity="0.16" />
          <stop offset="1" stopColor={AMBER} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={sky} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={STAGE} />
          <stop offset="1" stopColor={STAGE2} />
        </linearGradient>
      </defs>
      <rect width="640" height="400" fill={`url(#${sky})`} />
      <g stroke={DIM} strokeOpacity="0.07" strokeWidth="1">
        {[64, 128, 192, 256, 320, 384, 448, 512, 576].map((x) => (
          <line key={`v${x}`} x1={x} y1="0" x2={x} y2="400" />
        ))}
        {[80, 160, 240, 320].map((y) => (
          <line key={`h${y}`} x1="0" y1={y} x2="640" y2={y} />
        ))}
      </g>

      {kind === "dawn" && (
        <>
          <circle className="nx-art-glow" cx="430" cy="290" r="210" fill={`url(#${glow})`} />
          {[70, 120, 175, 235, 300].map((r, i) => (
            <circle key={r} className="nx-art-ring" data-i={i} cx="430" cy="290" r={r} fill="none" stroke={AMBER} strokeOpacity={0.34 - i * 0.05} strokeWidth="1.5" strokeDasharray={i % 2 ? "3 11" : "26 14"} />
          ))}
          <rect x="0" y="290" width="640" height="110" fill={STAGE} fillOpacity="0.82" />
          <line x1="0" y1="290" x2="640" y2="290" stroke={AMBER} strokeOpacity="0.5" strokeWidth="1.5" />
          <circle cx="430" cy="290" r="30" fill={AMBER} />
          <circle cx="430" cy="290" r="30" fill="none" stroke={AMBER} strokeOpacity="0.4" strokeWidth="10" />
          {[40, 90, 150, 210, 270].map((x, i) => (
            <circle key={x} className="nx-art-star" data-i={i} cx={x} cy={50 + ((i * 47) % 120)} r="1.6" fill={STAGE3} stroke={DIM} strokeOpacity="0.6" />
          ))}
        </>
      )}

      {kind === "rundown" && (
        <>
          {[
            { y: 92, a: 84, b: 520 },
            { y: 152, a: 120, b: 410 },
            { y: 212, a: 84, b: 470 },
            { y: 272, a: 200, b: 520 },
          ].map((t, i) => (
            <g key={t.y}>
              <rect x="64" y={t.y} width="512" height="34" rx="9" fill={STAGE3} fillOpacity="0.9" />
              <rect x={t.a} y={t.y + 6} width={t.b - t.a} height="22" rx="7" fill={AMBER} fillOpacity={0.07 + i * 0.025} stroke={AMBER} strokeOpacity="0.2" />
            </g>
          ))}
          <g className="nx-art-playhead">
            <line x1="64" y1="66" x2="64" y2="330" stroke={AMBER} strokeOpacity="0.55" strokeWidth="2" />
            <polygon points="56,58 72,58 64,70" fill={AMBER} />
          </g>
          <circle className="nx-art-glow" cx="548" cy="352" r="70" fill={`url(#${glow})`} />
          <circle cx="548" cy="352" r="11" fill={AMBER} />
        </>
      )}

      {kind === "tools" && (
        <>
          <circle className="nx-art-glow" cx="320" cy="200" r="190" fill={`url(#${glow})`} />
          {[0, 1, 2, 3, 4, 5].map((i) => {
            const a = (Math.PI * 2 * i) / 6 - Math.PI / 2;
            const x = 320 + Math.cos(a) * 150;
            const y = 200 + Math.sin(a) * 118;
            return (
              <g key={i}>
                <line x1="320" y1="200" x2={x} y2={y} stroke={AMBER} strokeOpacity="0.35" strokeWidth="1.5" />
                <line className="nx-art-pulse" data-i={i} x1="320" y1="200" x2={x} y2={y} stroke={AMBER} strokeWidth="3" strokeLinecap="round" strokeDasharray="6 190" />
                <circle cx={x} cy={y} r="17" fill={STAGE3} stroke={DIM} strokeOpacity="0.55" strokeWidth="1.5" />
                <circle cx={x} cy={y} r="5" fill={AMBER} fillOpacity={i % 2 ? 0.55 : 0.95} />
              </g>
            );
          })}
          <circle cx="320" cy="200" r="34" fill={STAGE3} stroke={AMBER} strokeWidth="2" />
          <circle cx="320" cy="200" r="12" fill={AMBER} />
        </>
      )}
    </svg>
  );
}

/**
 * The thumbnail the plan asks for, drawn: up to three of the topic's words, large, on the stage, with the lamp's glow
 * somewhere different for each topic (chosen from the words, so the same topic always gets the same one). It stands in
 * where the landing's example used to repeat the hero's still, and it is an illustration of the brief's "three words or
 * fewer on the picture", not a picture of anything.
 */
const SKIP = new Set(["about", "through", "with", "from", "into", "that", "this", "what", "when", "which", "while"]);

export function thumbWords(topic: string): string[] {
  const words = topic
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((w) => Array.from(w).length > 3 && !SKIP.has(w.toLowerCase()));
  return words.slice(0, 3);
}

export function ThumbArt({ topic, className = "" }: { topic: string; className?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const words = thumbWords(topic);
  let h = 0;
  for (const ch of topic) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  const spots = [
    [120, 300],
    [520, 90],
    [470, 320],
    [150, 70],
  ];
  const [gx, gy] = spots[h % spots.length];
  // The longest word fills at most the frame's width (a bold face is about 0.62 em a letter).
  const longest = Math.max(1, ...words.map((w) => Array.from(w).length));
  const size = Math.min(66, Math.floor(520 / (longest * 0.62)));
  return (
    <svg className={`nx-art-svg ${className}`.trim()} data-art="thumb" viewBox="0 0 640 360" preserveAspectRatio="xMidYMid meet" aria-hidden focusable="false">
      <defs>
        <radialGradient id={`t${uid}`} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor={AMBER} stopOpacity="0.6" />
          <stop offset="1" stopColor={AMBER} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="640" height="360" fill={STAGE} />
      <circle cx={gx} cy={gy} r="230" fill={`url(#t${uid})`} />
      <g stroke={DIM} strokeOpacity="0.08">
        {[90, 180, 270].map((y) => (
          <line key={y} x1="0" y1={y} x2="640" y2={y} />
        ))}
      </g>
      <rect x="26" y="26" width="588" height="308" rx="18" fill="none" stroke={AMBER} strokeOpacity="0.3" strokeWidth="2" />
      {words.map((w, i) => (
        <text key={`${w}${i}`} x="56" y={74 + size + i * (size + 12)} fontFamily="var(--font-display)" fontWeight="700" fontSize={size} letterSpacing="-1" fill={i === words.length - 1 ? AMBER : "var(--nx-stage-text)"}>
          {w}
        </text>
      ))}
    </svg>
  );
}
