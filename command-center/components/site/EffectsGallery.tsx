import type { CSSProperties } from "react";
import Link from "next/link";
import { fmt, type Dictionary } from "@/lib/i18n";
import { EFFECTS, publicEffectHref, type Effect } from "@/lib/effects/catalog";
import { levelSpans, masonryColumns, masonrySpan } from "@/lib/effects/masonry";
import { EffectFrame } from "@/components/effects/EffectFrame";
import { effectFrameRatio, effectSample } from "@/components/effects/effect-sample";
import { TapReveal } from "@/components/site/TapReveal";
import "@/components/effects/effects.css";
import "@/components/site/media-card.css";
import "@/components/site/effects-gallery.css";

/**
 * The public site's Effects section, media first like the explore grid (components/site/media-card.css, owner decision 22 Nov):
 * at rest a card is its sample (or a drawing that says, in words, that it is one) and one small corner mark, "AI-generated" on a
 * real result and "Drawing" on a drawing, so neither is taken for the other. On hover, keyboard focus or a first tap on a phone
 * (components/site/TapReveal.tsx) the effect's name, its one line and what it starts from show over a dark foot. The whole card
 * is one link: sign-up and then the Studio's video form with the effect in it (lib/effects/catalog.ts publicEffectHref).
 *
 * It names no model and no maker, like the rest of the public site (tests/helpers/brands.ts): which model an effect uses depends
 * on what the visitor's workspace is offered, and the Studio card says it there, with the price, before anything runs. Nothing
 * on this section prices, holds or starts anything (CLAUDE.md #3). A Server Component; the only client code is each drawing's
 * in-view switch and, once an effect has a real sample, the site's own clip player.
 *
 * Mount point on the landing (components/landing/Landing.tsx): directly after the model samples (ShowcaseGallery), so the visitor
 * sees real results first and then the named shots that start one. `id="effects"` is the anchor a nav link may use.
 */
export function EffectsGallery({ t, effects = EFFECTS }: { t: Dictionary; effects?: readonly Effect[] }) {
  if (effects.length === 0) return null;
  const fx = t.effects;
  const s = fx.site;
  // Only the two words the client frame shows: the whole dictionary would ride along in the page payload once per card.
  const label = { noSample: fx.noSample, sample: fx.sample };
  // The grid rows each card takes at two and at three columns, from its frame's real shape, and the column each goes in so the
  // columns end evenly (lib/effects/masonry.ts). Both only size and place: every card is in the list, in page order.
  const n2 = effects.map((e) => masonrySpan(effectFrameRatio(e), 2));
  const n3 = effects.map((e) => masonrySpan(effectFrameRatio(e), 3));
  const c2 = masonryColumns(n2, 2);
  const c3 = masonryColumns(n3, 3);
  // Media first, a card is its frame alone, so the columns are stretched to end level and each frame grows into its rows.
  const r2 = levelSpans(n2, c2, 2);
  const r3 = levelSpans(n3, c3, 3);
  return (
    <section id="effects" aria-labelledby="effects-title" className="nx-section efx">
      <div className="nx-wrap">
        <p className="nx-label">{s.label}</p>
        <h2 id="effects-title" className="nx-h2">
          {s.title}
        </h2>
        <p className="nx-sub">{s.lead}</p>
        <ul className="efx-grid" aria-label={s.listLabel}>
          {effects.map((e, i) => {
            const copy = fx.items[e.id];
            const rows = {
              "--efx-n2": r2[i],
              "--efx-n3": r3[i],
              ...(c2 && { "--efx-c2": c2[i] }),
              ...(c3 && { "--efx-c3": c3[i] }),
            } as CSSProperties;
            const capId = `efx-cap-${e.id}`;
            const badgeId = `efx-badge-${e.id}`;
            const aiId = `efx-ai-${e.id}`;
            const sampled = effectSample(e) !== null;
            return (
              <li key={e.id} className="efx-card mf-card" data-mf-card="" data-effect={e.id} style={rows}>
                <EffectFrame effect={e} label={label} className="fx-frame efx-frame" badgeId={badgeId} />
                {/* "AI" on a real result (owner decision 22 Nov: the mark is "AI" in every language); a drawing is not one, and says
                    "Drawing". The frame's badge (badgeId) says which in full, and the link's description reads it. */}
                <span className="mf-ai" aria-hidden>
                  {sampled ? t.site.gallery.mark : s.drawing}
                </span>
                {sampled && (
                  <span id={aiId} className="sr-only">
                    {t.site.gallery.badge}
                  </span>
                )}
                <span id={capId} className="mf-cap" aria-hidden>
                  <span className="mf-title efx-name">{copy.name}</span>
                  <span className="mf-desc efx-line">{copy.line}</span>
                  <span className="mf-facts efx-kind">
                    {fx.kinds[e.capability]} · {fmt(fx.desk.seconds, { n: e.duration })} · {fx.needs[e.input]}
                  </span>
                </span>
                {/* The stretched link over the whole card (media-card.css): named "Use this effect: …", described by the caption's
                    line and facts, and by whether the frame is a real result (AI-generated) or a drawing. */}
                <Link
                  href={publicEffectHref(e)}
                  prefetch={false}
                  className="mf-card-link"
                  aria-label={fmt(s.useAria, { name: copy.name })}
                  aria-describedby={[capId, badgeId, sampled ? aiId : null].filter(Boolean).join(" ")}
                />
              </li>
            );
          })}
        </ul>
        <TapReveal />
        <p className="nx-show-note">{s.note}</p>
      </div>
    </section>
  );
}
