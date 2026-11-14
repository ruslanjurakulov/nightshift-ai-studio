import type { CSSProperties } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { fmt, type Dictionary } from "@/lib/i18n";
import { EFFECTS, publicEffectHref, type Effect } from "@/lib/effects/catalog";
import { masonryColumns, masonrySpan } from "@/lib/effects/masonry";
import { EffectFrame } from "@/components/effects/EffectFrame";
import { effectFrameRatio } from "@/components/effects/effect-sample";
import "@/components/effects/effects.css";
import "@/components/site/effects-gallery.css";

/**
 * The public site's Effects section: each effect as a card with its sample (or a drawing that says, in words, that it is one), its
 * name, one line, what it starts from and its length, and "Use this effect", which is sign-up and then the Studio's video form
 * with the effect in it (lib/effects/catalog.ts publicEffectHref).
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
              "--efx-n2": n2[i],
              "--efx-n3": n3[i],
              ...(c2 && { "--efx-c2": c2[i] }),
              ...(c3 && { "--efx-c3": c3[i] }),
            } as CSSProperties;
            return (
              <li key={e.id} className="efx-card" data-effect={e.id} style={rows}>
                <EffectFrame effect={e} label={label} className="fx-frame efx-frame" />
                <div className="efx-body">
                  <p className="efx-kind">
                    {fx.kinds[e.capability]} · {fmt(fx.desk.seconds, { n: e.duration })}
                  </p>
                  <h3 className="efx-name">{copy.name}</h3>
                  <p className="efx-line">{copy.line}</p>
                  <p className="efx-needs">{fx.needs[e.input]}</p>
                  <Link href={publicEffectHref(e)} prefetch={false} className="nx-btn efx-use" aria-label={fmt(s.useAria, { name: copy.name })}>
                    {s.use}
                    <ArrowRight aria-hidden />
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="nx-show-note">{s.note}</p>
      </div>
    </section>
  );
}
