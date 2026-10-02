import Link from "next/link";
import { ArrowRight, Play } from "lucide-react";
import { fmt, type Dictionary, type Locale } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { WELCOME_CREDITS } from "@/lib/pricing";
import type { MoneyAnchor } from "@/lib/landing";
import { conceptCopy } from "@/lib/i18n/site/concepts";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { formatTimecode } from "@/components/ui/Timecode";
import { Stagger, StaggerItem } from "@/components/motion/Reveal";
import { Playhead } from "@/components/concepts/Playhead";
import { PriceFacts, PriceLine } from "@/components/concepts/PriceFacts";

/** An example timeline, 20 s long, labelled as one: every tick and label sits at a real position on it. */
const LENGTH = 20;
const TICKS = [0, 5, 10, 15, 20];
const CLIPS = [
  { from: 0, to: 6.2, scene: "ac-scene-a" },
  { from: 6.2, to: 13.4, scene: "ac-scene-b" },
  { from: 13.4, to: 20, scene: "ac-scene-c" },
];
const TEXT = { from: 0.6, to: 9.6 };
const PLAYHEAD = 12.6;
const pct = (s: number) => (s / LENGTH) * 100;
/** A fixed, made-up waveform: the same every render, so nothing shifts. */
const WAVE = Array.from({ length: 64 }, (_, i) => 0.35 + 0.55 * Math.abs(Math.sin(i * 0.9) * Math.cos(i * 0.37)));

const VERDICT_TONES: LampTone[] = ["ok", "ok", "run"];

/**
 * Concept C, "The screen waiting": the hero is the moment the product exists
 * for. A finished video is on its own screen, drawn large: the player with a
 * drawn frame, a timeline of three clips with the playhead at the end, and
 * beside the player the verdicts it waits on (private on YouTube, the publish
 * check passed, your approval open), auto-publish off, and the Approve key.
 * The headline is the caption of that screen.
 *
 * Truth: an illustration, labelled "Example" (t.site.rundown.tag) and
 * described in full for assistive technology, in the live page's words. The
 * scenes are flat drawn shapes, not generated pictures; the 20 s length and
 * the clip lengths are an example, as in the Studio section's editor picture.
 * The topic is the live page's sample topic. Nothing here can be pressed.
 *
 * Motion: the clips print in order and the playhead travels in once; the
 * waiting lamp breathes. Reduced motion: complete and still.
 */
export function ConceptC({ t, locale, anchor }: { t: Dictionary; locale: Locale; anchor: MoneyAnchor }) {
  const h = t.site.hero;
  const r = t.site.rundown;
  const e = t.site.studio.editor;
  const approval = t.site.rules.items.find((i) => i.id === "approval");
  const topic = r.rows.find((row) => row.id === "topic")?.detail ?? "";
  const c = conceptCopy[locale];
  const d = t.site.desk;
  return (
    <section aria-labelledby="cc-title" className="ac-c">
      <div className="st-wrap ac-c-grid">
        <div className="ac-c-words">
          <p className="st-kicker">{h.kicker}</p>
          <h1 id="cc-title" className="ac-c-h1 mt-5">
            {h.titleA} <span>{h.titleB}</span>
          </h1>
          <p className="st-lead mt-6">{h.lead}</p>
          <div className="st-hero-actions">
            <Link href="/signup" className="st-key">
              {h.cta}
              <ArrowRight aria-hidden />
            </Link>
            <Link href="/pricing" className="st-link">
              {h.secondary}
            </Link>
          </div>
          <p className="st-hero-note">
            <span aria-hidden className="ns-lamp" data-tone="ok" />
            {fmt(h.note, { n: formatCredits(WELCOME_CREDITS, locale) })}
          </p>
          <PriceLine t={t} locale={locale} anchor={anchor} />
        </div>

        <figure role="img" aria-label={c.screenFigure} className="ac-c-screen">
          <div className="ac-c-bar">
            <b>{topic}</b>
            <span className="st-tag">{r.tag}</span>
          </div>

          <div className="ac-c-stage">
            <div className="ac-c-player">
              <div className="ac-c-frame">
                <div className="ac-scene-big" aria-hidden>
                  <i className="sun" />
                  <i className="dune-far" />
                  <i className="wall" />
                  <i className="tower l" />
                  <i className="tower r" />
                  <i className="dome" />
                  <i className="dune-near" />
                </div>
              </div>
              <div className="ac-c-rebate st-num">
                <span>16:9</span>
                <span>{formatTimecode(PLAYHEAD, "frames")}</span>
                <span className="ac-c-rebate-end">{formatTimecode(LENGTH, "duration")}</span>
              </div>
            </div>

            <div className="ac-c-verdicts">
              <p className="ac-c-vhead">{c.verdicts}</p>
              <ul>
                {(approval?.lines ?? []).map((line, i) => (
                  <li key={line}>
                    <StatusLamp
                      tone={VERDICT_TONES[i] ?? "ok"}
                      label={line}
                      live={VERDICT_TONES[i] === "run"}
                      size="md"
                    />
                  </li>
                ))}
                <li>
                  <StatusLamp tone="idle" label={`${d.cols.autopublish}: ${d.off}`} size="md" />
                </li>
              </ul>
              <div className="ac-c-keys">
                <span className="st-fake-key">
                  <Play aria-hidden />
                  {r.watch}
                </span>
                <span className="st-fake-key" data-lit="true">
                  {r.approve}
                </span>
              </div>
            </div>
          </div>

          <div className="ac-c-tl">
            <div className="ac-c-tl-ruler">
              <span />
              <div className="ac-c-ticks">
                {TICKS.map((s) => (
                  <span
                    key={s}
                    className="st-num"
                    style={s === LENGTH ? { right: 0 } : { left: `${pct(s)}%` }}
                  >
                    {formatTimecode(s, "duration")}
                  </span>
                ))}
              </div>
            </div>
            <div className="ac-c-track">
              <span className="ac-c-label">{e.tracks.video}</span>
              <Stagger as="div" trigger="mount" firstPaint className="ac-c-lane" data-kind="video">
                {CLIPS.map((clip, i) => (
                  <StaggerItem
                    as="div"
                    index={i}
                    key={clip.scene}
                    className="ac-c-clip"
                    style={{ left: `calc(${pct(clip.from)}% + 1px)`, width: `calc(${pct(clip.to - clip.from)}% - 2px)` }}
                  >
                    <div className="ac-c-clip-edge">
                      <span>{String(i + 1).padStart(2, "0")}</span>
                      <span>{formatTimecode(clip.to - clip.from, "duration")}</span>
                      <span className="hidden truncate sm:inline">{e.clips[i]}</span>
                    </div>
                    <div className={`ac-c-clip-pic ${clip.scene}`} />
                  </StaggerItem>
                ))}
              </Stagger>
            </div>
            <div className="ac-c-track">
              <span className="ac-c-label">{e.tracks.text}</span>
              <div className="ac-c-lane" data-kind="text">
                <div className="ac-c-textclip" style={{ left: `${pct(TEXT.from)}%`, width: `${pct(TEXT.to - TEXT.from)}%` }}>
                  <span className="min-w-0 truncate">{e.caption}</span>
                </div>
              </div>
            </div>
            <div className="ac-c-track">
              <span className="ac-c-label">{e.tracks.music}</span>
              <div className="ac-c-lane" data-kind="music">
                <div className="ac-c-wave">
                  <svg viewBox="0 0 128 20" preserveAspectRatio="none" aria-hidden>
                    {WAVE.map((hh, i) => (
                      <rect key={i} x={i * 2} y={10 - hh * 9} width="1.1" height={hh * 18} fill="currentColor" opacity={i > 50 ? 0.9 - (i - 50) * 0.06 : 0.9} />
                    ))}
                  </svg>
                </div>
              </div>
            </div>
            {/* The playhead crosses all three tracks; the label column is a fixed width so its offset is a constant. */}
            <div className="ac-c-overlay">
              <Playhead at={pct(PLAYHEAD)}>
                <span className="ac-c-playhead" />
              </Playhead>
            </div>
          </div>

          <div className="ac-c-foot">
            <span className="ac-c-price">{r.price}</span>
          </div>
        </figure>
      </div>
      <div className="st-wrap">
        <PriceFacts t={t} locale={locale} anchor={anchor} titleId="cc-cost" className="ac-c-facts" />
      </div>
    </section>
  );
}
