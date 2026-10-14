import { Lock } from "lucide-react";
import { fmt, type Dictionary } from "@/lib/i18n";
import { FRAME_PRESETS } from "@/lib/editorFrame";

type Copy = Dictionary["site"]["studioPage"];

/**
 * The three drawn examples on /studio. They are explainer blocks, not screenshots: type and boxes only, in the site's
 * own surfaces, each tagged "Example" like the landing demo, each one image to assistive technology (the figure's
 * label says what it shows and that it is an example). Nothing in them can be pressed, and nothing in them is data.
 */
function Frame({ label, title, tag, children }: { label: string; title: string; tag: string; children: React.ReactNode }) {
  return (
    <figure role="img" aria-label={label} className="sp-fig">
      <div className="st-monitor">
        <div className="st-monitor-head">
          <div className="st-monitor-title">
            <b>{title}</b>
          </div>
          <span className="st-tag">{tag}</span>
        </div>
        <div className="sp-body" aria-hidden>
          {children}
        </div>
      </div>
    </figure>
  );
}

/** A storyboard waiting for review: scene cards, then the approve key that carries its price. */
export function StoryboardExample({ p }: { p: Copy }) {
  const s = p.plan;
  return (
    <Frame label={s.figure} title={s.figureTitle} tag={p.example}>
      {s.scenes.map((sc, i) => (
        <div key={sc.narration} className="sp-scene">
          <b>{fmt(s.scene, { n: i + 1 })}</b>
          <span>
            <small>{s.narration}: </small>
            {sc.narration}
          </span>
          <span>
            <small>{s.visual}: </small>
            {sc.visual}
          </span>
        </div>
      ))}
      <div className="sp-actions">
        <span className="sp-fake-key">{s.approve}</span>
        <span className="sp-fake-key" data-quiet="true">
          {s.discard}
        </span>
        <span className="sp-hint">{s.approveNote}</span>
      </div>
    </Frame>
  );
}

/** The editor: three tracks (the cross-fade drawn as a dashed edge), the three frame shapes, Save and Export. */
export function EditorExample({ p, t }: { p: Copy; t: Dictionary }) {
  const e = p.editor;
  const widths = ["30%", "38%", "32%"];
  return (
    <Frame label={e.figure} title={e.figureTitle} tag={p.example}>
      <div className="sp-track">
        <b>{e.tracks.video}</b>
        <div className="sp-lane">
          {e.clips.map((name, i) => (
            <span key={name} className="sp-clip" data-xf={i > 0 ? "true" : undefined} style={{ width: widths[i] }}>
              {name}
            </span>
          ))}
        </div>
      </div>
      <div className="sp-track">
        <b>{e.tracks.text}</b>
        <div className="sp-lane">
          <span className="sp-clip" style={{ marginLeft: "12%", width: "52%" }}>
            {e.caption}
          </span>
        </div>
      </div>
      <div className="sp-track">
        <b>{e.tracks.music}</b>
        <div className="sp-lane">
          <span className="sp-clip" style={{ width: "100%" }}>
            {e.tracks.music} · {e.fade}
          </span>
        </div>
      </div>
      <div className="sp-row">
        <span className="st-small">{e.frames}</span>
        <span className="st-fake-seg">
          {FRAME_PRESETS.map((f, i) => (
            <span key={f.id} data-on={i === 1 ? "true" : undefined} className="st-num">
              {f.id}
            </span>
          ))}
        </span>
      </div>
      <div className="sp-actions">
        <span className="sp-fake-key" data-quiet="true">
          {e.save}
        </span>
        <span className="sp-fake-key">{e.export}</span>
        <span className="sp-hint">{t.editor.freeNote}</span>
      </div>
    </Frame>
  );
}

/** A video waiting before it goes public: the three states, the last one lit as waiting. */
export function PublishExample({ p }: { p: Copy }) {
  const b = p.publish;
  return (
    <Frame label={b.figure} title={b.figureTitle} tag={p.example}>
      <ol className="sp-states">
        {b.lines.map((line, i) => (
          <li key={line} data-wait={i === b.lines.length - 1 ? "true" : undefined}>
            {i === 0 ? <Lock className="size-4 shrink-0" aria-hidden /> : <span aria-hidden className="ns-lamp" data-tone={i === 1 ? "ok" : "idle"} />}
            <span>{line}</span>
          </li>
        ))}
      </ol>
    </Frame>
  );
}
