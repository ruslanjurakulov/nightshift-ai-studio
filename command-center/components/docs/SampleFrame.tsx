import { Check } from "lucide-react";
import type { FrameKind, SceneKind } from "@/lib/dev/mcp-landing";

/**
 * The pictures on the long /mcp page. Every one is DRAWN here (inline SVG and
 * CSS, the site's own tokens), never a generated image or a screenshot, and each
 * sits in a <figure> whose caption says it is an illustration. They show the
 * shape of a step (a job with its stages, a list of channels, a publish check),
 * not a result: no number, price or model appears in any of them.
 */

/** A drawn scene for a sample video frame or an example card. Pure geometry; the same in both themes, like a photo. */
export function Scene({ kind }: { kind: SceneKind }) {
  return (
    <svg className="ml-scene" data-scene={kind} viewBox="0 0 200 250" preserveAspectRatio="xMidYMid slice" aria-hidden focusable="false" xmlns="http://www.w3.org/2000/svg">
      {kind === "hills" && (
        <>
          <rect width="200" height="250" fill="#f6c58b" />
          <rect width="200" height="120" fill="#fbdcae" />
          <circle cx="132" cy="92" r="30" fill="#f08a3c" />
          <path d="M0 160 Q50 110 110 150 T200 140 V250 H0Z" fill="#c4683a" />
          <path d="M0 190 Q60 150 120 185 T200 175 V250 H0Z" fill="#8f4a34" />
          <path d="M0 220 Q70 195 130 215 T200 208 V250 H0Z" fill="#4b2b2a" />
        </>
      )}
      {kind === "waves" && (
        <>
          <rect width="200" height="250" fill="#14395e" />
          <rect width="200" height="110" fill="#2a6a9a" />
          <circle cx="60" cy="70" r="18" fill="#e9f3fb" opacity="0.9" />
          <path d="M0 140 Q25 120 50 140 T100 140 T150 140 T200 140 V250 H0Z" fill="#1e5a88" />
          <path d="M0 175 Q25 155 50 175 T100 175 T150 175 T200 175 V250 H0Z" fill="#17486f" />
          <path d="M0 210 Q25 192 50 210 T100 210 T150 210 T200 210 V250 H0Z" fill="#0f3252" />
        </>
      )}
      {kind === "city" && (
        <>
          <rect width="200" height="250" fill="#3a2a5c" />
          <rect width="200" height="130" fill="#6c4a8a" />
          <circle cx="150" cy="60" r="14" fill="#f7d9a8" />
          {[
            [12, 120, 34], [44, 96, 28], [70, 132, 36], [104, 84, 32], [140, 112, 30], [168, 100, 32],
          ].map(([x, y, w]) => (
            <g key={x}>
              <rect x={x} y={y} width={w} height={250 - y} fill="#1c1531" />
              {[0, 1, 2, 3].map((r) => (
                <rect key={r} x={x + 6} y={y + 10 + r * 20} width="6" height="8" fill={r % 2 ? "#f7d9a8" : "#7d6aa3"} />
              ))}
            </g>
          ))}
        </>
      )}
      {kind === "stars" && (
        <>
          <rect width="200" height="250" fill="#0e1330" />
          <path d="M120 40a34 34 0 1 0 28 56a28 28 0 1 1-28-56z" fill="#f4e7bf" />
          {[[24, 30], [60, 80], [90, 24], [170, 150], [40, 170], [130, 200], [180, 60], [74, 140], [150, 110], [20, 220]].map(([x, y]) => (
            <circle key={`${x}${y}`} cx={x} cy={y} r={x % 3 ? 1.4 : 2} fill="#fff" opacity="0.85" />
          ))}
          <path d="M0 230 Q60 200 120 228 T200 220 V250 H0Z" fill="#05081a" />
        </>
      )}
      {kind === "rings" && (
        <>
          <rect width="200" height="250" fill="#e9825a" />
          <circle cx="100" cy="125" r="96" fill="#f2a56b" />
          <circle cx="100" cy="125" r="68" fill="#f7c78c" />
          <circle cx="100" cy="125" r="40" fill="#fbe3b6" />
          <circle cx="100" cy="125" r="16" fill="#c14b3a" />
        </>
      )}
      {kind === "dunes" && (
        <>
          <rect width="200" height="250" fill="#f1d9a6" />
          <rect width="200" height="100" fill="#f9ecc8" />
          <circle cx="48" cy="58" r="22" fill="#e9a23d" />
          <path d="M0 130 Q70 90 140 135 T200 120 V250 H0Z" fill="#dba85c" />
          <path d="M0 175 Q80 140 150 180 T200 170 V250 H0Z" fill="#c68a42" />
          <path d="M0 220 Q60 195 120 218 T200 210 V250 H0Z" fill="#a8672f" />
        </>
      )}
    </svg>
  );
}

export type FrameWords = {
  note: string;
  video: { title: string; stages: string[] };
  channels: { head: string; rows: { name: string; language: string; voice: string }[] };
  voice: { head: string; languages: string[]; voice: string };
  approve: { head: string; lines: string[]; button: string };
  credits: { head: string; bars: string[]; rules: string[] };
  batch: { head: string; rows: { topic: string; state: string }[] };
};

/** One drawn frame, by kind, with its illustration caption underneath. */
export function SampleFrame({ kind, words }: { kind: FrameKind; words: FrameWords }) {
  return (
    <figure className="ml-fig">
      <div className="ml-frame" data-kind={kind} aria-hidden>
        {kind === "video" && (
          <>
            <div className="ml-frame-screen">
              <Scene kind="hills" />
              <span className="ml-frame-play" />
              <span className="ml-frame-cap">{words.video.title}</span>
            </div>
            <ul className="ml-stages">
              {words.video.stages.map((s) => (
                <li key={s}>
                  <Check />
                  {s}
                </li>
              ))}
            </ul>
          </>
        )}
        {kind === "channels" && (
          <>
            <p className="ml-frame-head">{words.channels.head}</p>
            <ul className="ml-chlist">
              {words.channels.rows.map((r, i) => (
                <li key={r.name}>
                  <span className="ml-chdot" data-i={i} />
                  <span className="ml-chname">{r.name}</span>
                  <span className="ml-chmeta">
                    {r.language} · {r.voice}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {kind === "voice" && (
          <>
            <p className="ml-frame-head">{words.voice.head}</p>
            <div className="ml-wave">
              {Array.from({ length: 36 }, (_, i) => (
                <i key={i} style={{ height: `${18 + ((i * 37) % 61)}%` }} />
              ))}
            </div>
            <p className="ml-chips">
              {words.voice.languages.map((l, i) => (
                <span key={l} data-on={i === 1 || undefined}>
                  {l}
                </span>
              ))}
            </p>
            <p className="ml-frame-meta">{words.voice.voice}</p>
          </>
        )}
        {kind === "approve" && (
          <>
            <p className="ml-frame-head">{words.approve.head}</p>
            <ul className="ml-checks">
              {words.approve.lines.map((l, i) => (
                <li key={l} data-wait={i === words.approve.lines.length - 1 || undefined}>
                  <span className="ml-lamp" />
                  {l}
                </li>
              ))}
            </ul>
            <span className="ml-fake-btn">{words.approve.button}</span>
          </>
        )}
        {kind === "credits" && (
          <>
            <p className="ml-frame-head">{words.credits.head}</p>
            {words.credits.bars.map((b, i) => (
              <div key={b} className="ml-meter">
                <span>{b}</span>
                <i style={{ ["--fill" as string]: ["62%", "22%", "40%"][i] }} />
              </div>
            ))}
            <ul className="ml-rules">
              {words.credits.rules.map((r) => (
                <li key={r}>
                  <Check />
                  {r}
                </li>
              ))}
            </ul>
          </>
        )}
        {kind === "batch" && (
          <>
            <p className="ml-frame-head">{words.batch.head}</p>
            <ul className="ml-batch">
              {words.batch.rows.map((r, i) => (
                <li key={r.topic} data-s={i}>
                  <span className="ml-batch-tile">
                    <Scene kind={(["stars", "waves", "dunes"] as const)[i]} />
                  </span>
                  <span className="ml-batch-t">{r.topic}</span>
                  <span className="ml-batch-s">{r.state}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <figcaption className="ml-fig-cap">{words.note}</figcaption>
    </figure>
  );
}
