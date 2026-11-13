import { Lock } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { ASPECT_RATIOS } from "@/lib/creative/studio";
import { slotMedia } from "@/components/site/samples";
import { AiBadge, PlaceFill, placeBox } from "@/components/site/PlaceFill";
import { creditLine } from "@/lib/site/media";

/**
 * The Studio composer, drawn: a description, the shape keys, a style chip and
 * the Generate key with its price legend. The legend says where the price
 * goes rather than printing a number — this page cannot know today's price,
 * and a made-up one would be a promise (CLAUDE.md #5). One image to assistive
 * tech; nothing in it can be pressed.
 */
export function ComposerPicture({ t }: { t: Dictionary }) {
  const c = t.site.solutions.pictures.composer;
  return (
    <figure role="img" aria-label={c.figure} className="st-monitor">
      <div className="st-monitor-head">
        <div className="st-monitor-title">
          <b>{c.title}</b>
        </div>
        <span className="st-tag">{c.tag}</span>
      </div>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-2">
          <span className="st-kicker text-sm">{c.describe}</span>
          <div className="min-h-[96px] rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--ns-key)] p-3 text-[15px] leading-relaxed">
            {c.prompt}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="flex flex-col gap-2">
            <span className="st-kicker text-sm">{c.shape}</span>
            <span className="st-fake-seg">
              {ASPECT_RATIOS.map((a, i) => (
                <span key={a} data-on={i === 0 ? "true" : undefined} className="st-num">
                  {a}
                </span>
              ))}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <span className="st-kicker text-sm">{c.style}</span>
            <span className="st-fake-chip">
              <span className="truncate">{c.styleName}</span>
            </span>
          </div>
        </div>
        {/* Drawn outlined with its lamp: the page's own CTA is the only filled key in view. */}
        <span className="st-fake-generate">
          <span className="st-fake-generate-word">
            <span aria-hidden className="ns-lamp" data-tone="run" />
            {c.generate}
          </span>
          <span className="st-fake-generate-price">{c.price}</span>
        </span>
      </div>
    </figure>
  );
}

/** The API's endpoints as the reference lists them — real paths, read off the routes. */
export function ApiPicture({ t }: { t: Dictionary }) {
  const a = t.site.solutions.pictures.api;
  return (
    <figure className="st-monitor" aria-labelledby="api-picture-title">
      <div className="st-monitor-head">
        <div className="st-monitor-title">
          <b id="api-picture-title">{a.title}</b>
        </div>
        <span className="st-tag">{a.tag}</span>
      </div>
      <figcaption className="sr-only">{a.figure}</figcaption>
      <ul className="st-rows">
        {a.rows.map((r) => (
          <li key={r.method + r.path} className="grid gap-1 border-b border-[var(--ns-rule)] px-4 py-3 last:border-b-0">
            {/* The method sits on its own line and the path never breaks: "/publi sh" was a path split mid-word at phone width. */}
            <span className="st-num text-sm font-semibold text-[var(--ns-amber-ink)]">{r.method}</span>
            <code className="st-num block whitespace-nowrap text-sm">{r.path}</code>
            <span className="text-sm text-[var(--ns-text-dim)]">{r.body}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

/**
 * For channel operators: one finished video at the publish desk — the frame of
 * the video itself, private on YouTube, and the two gates it passes before it
 * airs (the publish check, then the owner's own approval). A different picture
 * from the landing's rundown: this is the last step up close, not the whole
 * run. One image to assistive tech; nothing in it can be pressed.
 */
export function SignOffPicture({ t }: { t: Dictionary }) {
  const s = t.site.solutions.pictures.signoff;
  const gates = [
    { id: "check", name: s.check, state: s.checkState, tone: "ok" as const },
    { id: "first", name: s.first, state: s.firstState, tone: "run" as const },
  ];
  const m = slotMedia("solutions.youtube-channels");
  return (
    <>
    <figure role="img" aria-label={s.figure} className="st-monitor">
      <div className="st-monitor-head">
        <div className="st-monitor-title">
          <b>{s.title}</b>
          <span>{s.channel}</span>
        </div>
        <span className="st-tag">{s.tag}</span>
      </div>
      <div className="flex flex-col gap-4 p-4">
        {/* The desk's own frame is what the slot shows (one of our samples, or stock footage, each labelled as what it is); the desk around it is the drawing. */}
        <div className="st-signoff-frame" {...placeBox(m)}>
          <PlaceFill media={m} s={t.site} alt="" compact labels={false} sizes="(min-width: 860px) 480px, calc(100vw - 96px)" />
          <span className="st-signoff-private">{s.private}</span>
          {m.kind === "ai" ? (
            <span className="nx-result-badge st-signoff-badge" data-kind="ai">
              {t.site.gallery.badge}
            </span>
          ) : (
            <>
              <span className="nx-result-badge st-signoff-badge" data-kind="still">
                {m.footage ? t.site.samples.frameTag : t.site.samples.tag}
              </span>
              {m.clip && (
                <span className="nx-result-badge st-signoff-badge" data-kind="clip">
                  {t.site.samples.clipTag}
                </span>
              )}
              <span className="nx-result-credit">{creditLine(m.id, t.site.samples.credit)}</span>
            </>
          )}
        </div>
        {/* On a phone the frame is too small for three labels: its label and credit are a caption under it instead. A sample's badge is printed again under the drawing, where assistive tech reads it. */}
        {m.kind === "stock" && (
          <p className="st-signoff-caption">
            <span data-kind="still">{m.footage ? t.site.samples.frameTag : t.site.samples.tag}</span>
            {m.clip && <span data-kind="clip">{t.site.samples.clipTag}</span>}
            {` · ${creditLine(m.id, t.site.samples.credit)}`}
          </p>
        )}
        <p className="st-signoff-title">{s.video}</p>
        <ol className="st-signoff-gates">
          {gates.map((g) => (
            <li key={g.id} data-tone={g.tone}>
              <span className="st-signoff-name">{g.name}</span>
              <StatusLamp tone={g.tone} label={g.state} live={g.tone === "run"} />
            </li>
          ))}
        </ol>
        <p className="flex items-center gap-2 text-sm text-[var(--ns-text-dim)]">
          <Lock className="size-4 shrink-0" aria-hidden />
          {s.air}
        </p>
      </div>
    </figure>
    {/* A role="img" figure hides its words from assistive tech, so the sample's AI-generated badge is said again under it, in the sample's own box. */}
    {m.kind === "ai" && (
      <p className="nx-place-credit" {...placeBox({ ...m, moving: false })}>
        <AiBadge g={t.site.gallery} />
      </p>
    )}
    </>
  );
}
