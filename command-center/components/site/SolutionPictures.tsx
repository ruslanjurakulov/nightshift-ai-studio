import type { Dictionary } from "@/lib/i18n";
import { ASPECT_RATIOS } from "@/lib/creative/studio";

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
          <span className="st-kicker text-[12px]">{c.describe}</span>
          <div className="min-h-[96px] rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--ns-key)] p-3 text-[15px] leading-relaxed">
            {c.prompt}
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <div className="flex flex-col gap-2">
            <span className="st-kicker text-[12px]">{c.shape}</span>
            <span className="st-fake-seg">
              {ASPECT_RATIOS.map((a, i) => (
                <span key={a} data-on={i === 0 ? "true" : undefined} className="st-num">
                  {a}
                </span>
              ))}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <span className="st-kicker text-[12px]">{c.style}</span>
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
            <code className="st-num flex flex-wrap items-baseline gap-x-3 text-[13px]">
              <span className="font-semibold text-[var(--ns-amber-ink)]">{r.method}</span>
              <span className="break-all">{r.path}</span>
            </code>
            <span className="text-[13.5px] text-[var(--ns-text-dim)]">{r.body}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
