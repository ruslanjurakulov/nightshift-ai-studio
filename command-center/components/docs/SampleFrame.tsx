import { Check } from "lucide-react";
import type { FrameKind, SceneKind } from "@/lib/dev/mcp-landing";
import { SAMPLES, type SampleId } from "@/components/site/samples";

/**
 * The pictures on the long /mcp page. The frames are drawn here (inline SVG and
 * CSS, the site's own tokens) around example stills (AI-generated, made for the
 * site; see components/site/samples.tsx), and each sits in a <figure> whose
 * caption says it is an example. They show the shape of a step (a job with its
 * stages, a list of channels, a publish check), not a result: no number, price
 * or model appears in any of them.
 */

/** The example frame behind each scene kind (components/site/samples.tsx): AI-generated stills, shown with
 *  "Example" labels wherever they stand alone. Aspect-ratio boxes in the stylesheet decide the layout. */
const SCENE_SAMPLE: Record<SceneKind, SampleId> = {
  hills: "valley",
  waves: "lighthouse",
  city: "nightmarket",
  stars: "moon",
  rings: "library",
  dunes: "silkroad",
};

/** An example frame for a sample video frame or an example card. `alt` is empty inside the aria-hidden drawn
 *  frames and descriptive where the picture stands alone (the examples carousel). */
export function Scene({ kind, alt = "" }: { kind: SceneKind; alt?: string }) {
  const s = SAMPLES[SCENE_SAMPLE[kind]];
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="ml-scene" data-scene={kind} src={s.src} width={s.width} height={s.height} alt={alt} loading="lazy" decoding="async" />
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
