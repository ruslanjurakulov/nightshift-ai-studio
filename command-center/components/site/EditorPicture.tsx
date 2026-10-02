import type { Dictionary } from "@/lib/i18n";
import { formatTimecode } from "@/components/ui/Timecode";

/** A 20-second example timeline; every tick and label sits at a real position on it. */
const LENGTH = 20;
const TICKS = [0, 5, 10, 15, 20];
const CLIPS = [
  { from: 0, to: 6.2, scene: "st-scene-a" },
  { from: 6.2, to: 13.4, scene: "st-scene-b" },
  { from: 13.4, to: 20, scene: "st-scene-c" },
];
// Long enough that "Samarkand, 1404" reads whole on a phone's lane too.
const TEXT = { from: 0.6, to: 9.6 };
// Late in the second clip: clear of its edge print, of the 0:10 tick label and
// of the third clip, at every width.
const PLAYHEAD = 12.6;
const pct = (s: number) => `${(s / LENGTH) * 100}%`;

/** A fixed, made-up waveform (the same every render, so nothing shifts). */
const WAVE = Array.from({ length: 64 }, (_, i) => 0.35 + 0.55 * Math.abs(Math.sin(i * 0.9) * Math.cos(i * 0.37)));

/**
 * The Studio section's picture: the editor's timeline, drawn with the
 * identity's parts — film frames with their edge print, a seconds ruler, the
 * amber playhead with its frame timecode. One image to assistive tech, labelled
 * as an illustration; the scenes are flat shapes, not generated pictures.
 */
export function EditorPicture({ t }: { t: Dictionary }) {
  const e = t.site.studio.editor;
  return (
    <figure role="img" aria-label={e.figure} className="st-panel">
      <div className="st-panel-head">
        <b>{e.title}</b>
        <span className="st-tag">{e.tag}</span>
      </div>
      <div className="st-tl relative">
        {/* The playhead's head row: its timecode lives here, above the ruler. */}
        <div className="st-tl-head" />
        <div className="st-tl-ruler">
          <span />
          <div className="st-tl-ticks">
            {TICKS.map((s) => (
              <span key={s} className="st-num" style={{ left: s === LENGTH ? `calc(${pct(s)} - 22px)` : pct(s) }}>
                {formatTimecode(s, "duration")}
              </span>
            ))}
          </div>
        </div>

        <div>
          <div className="st-tl-track">
            <span className="st-tl-label">{e.tracks.video}</span>
            <div className="st-tl-lane">
              {CLIPS.map((c, i) => (
                <div
                  key={c.scene}
                  className="st-clip"
                  style={{ left: `calc(${pct(c.from)} + 1px)`, width: `calc(${pct(c.to - c.from)} - 2px)` }}
                >
                  <div className="st-clip-edge">
                    <span>{String(i + 1).padStart(2, "0")}</span>
                    <span>{formatTimecode(c.to - c.from, "duration")}</span>
                    <span className="hidden truncate sm:inline">{e.clips[i]}</span>
                  </div>
                  <div className={`st-clip-pic ${c.scene}`} />
                </div>
              ))}
            </div>
          </div>
          <div className="st-tl-track">
            <span className="st-tl-label">{e.tracks.text}</span>
            <div className="st-tl-lane" data-kind="text">
              <div className="st-textclip" style={{ left: pct(TEXT.from), width: pct(TEXT.to - TEXT.from) }}>
                <span className="min-w-0 truncate">{e.caption}</span>
              </div>
            </div>
          </div>
          <div className="st-tl-track">
            <span className="st-tl-label">{e.tracks.music}</span>
            <div className="st-tl-lane" data-kind="music">
              <div className="st-wave">
                <svg viewBox="0 0 128 20" preserveAspectRatio="none" aria-hidden>
                  {WAVE.map((h, i) => (
                    <rect key={i} x={i * 2} y={10 - h * 9} width="1.1" height={h * 18} fill="currentColor" opacity={i > 50 ? 0.9 - (i - 50) * 0.06 : 0.9} />
                  ))}
                </svg>
              </div>
            </div>
          </div>
        </div>
        <div className="st-tl-overlay">
          <div className="st-playhead" style={{ left: pct(PLAYHEAD) }}>
            <span className="st-playhead-tc st-num">{formatTimecode(PLAYHEAD, "frames")}</span>
          </div>
        </div>
      </div>
    </figure>
  );
}
