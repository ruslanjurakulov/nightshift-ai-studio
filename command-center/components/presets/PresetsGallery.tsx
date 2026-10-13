"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import { ArrowRight, Search } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelSlug } from "@/lib/channels-client";
import { PRESET_KINDS, buildPresetCards, filterPresets, type PresetKind } from "@/lib/presets";
import { Chip } from "@/components/ui/Chip";
import { Section } from "@/components/g3/Section";
import { PresetArt } from "@/components/presets/PresetArt";
import "@/components/presets/presets.css";

/**
 * The Presets & looks gallery: the starting points the product already has
 * (video formats, looks, Studio starters, voices) as cards, filtered by kind
 * and by a client-side search.
 *
 * A card is a plain link into the form that already takes it. It fills that
 * form and nothing else: this page prices nothing, holds nothing and makes no
 * request of its own — the form shows the price and asks before anything runs.
 */
export function PresetsGallery() {
  const { t, locale } = useI18n();
  const tp = t.presets;
  const slug = useChannelSlug();
  const searchId = useId();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<PresetKind | null>(null);

  const cards = useMemo(() => buildPresetCards(slug, locale, t), [slug, locale, t]);
  const shown = useMemo(() => filterPresets(cards, query, kind), [cards, query, kind]);
  const filtered = query.trim() !== "" || kind !== null;
  const clear = () => {
    setQuery("");
    setKind(null);
  };

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-4" aria-label={tp.searchLabel}>
        <div className="pr-search">
          <label htmlFor={searchId} className="sr-only">
            {tp.searchLabel}
          </label>
          <Search aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[var(--color-muted)]" />
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tp.searchPlaceholder}
            autoComplete="off"
            className="ns-field w-full !pl-10"
          />
        </div>

        <div role="group" aria-label={tp.filterLabel} className="pr-chips">
          <Chip className="tap" pressed={kind === null} onClick={() => setKind(null)}>
            {tp.kinds.all}
          </Chip>
          {PRESET_KINDS.map((k) => (
            <Chip key={k} className="tap" pressed={kind === k} onClick={() => setKind(kind === k ? null : k)}>
              {tp.kinds[k]}
            </Chip>
          ))}
        </div>

        <div className="pr-meta">
          <p aria-live="polite" className="m-0 tnum">
            {fmt(tp.count, { n: shown.length, total: cards.length })}
          </p>
          {filtered && (
            <button type="button" onClick={clear} className="tap-link g2-link">
              {tp.clear}
            </button>
          )}
        </div>
      </section>

      {shown.length === 0 ? (
        <div className="flex flex-col items-start gap-3" role="status">
          <p className="m-0 text-base font-semibold text-[var(--color-fg)]">{tp.noMatchTitle}</p>
          <p className="g2-none">{tp.noMatch}</p>
          <button type="button" onClick={clear} className="btn-quiet">
            {tp.clear}
          </button>
        </div>
      ) : (
        PRESET_KINDS.map((k) => {
          const group = shown.filter((c) => c.kind === k);
          if (group.length === 0) return null;
          return (
            <Section key={k} title={tp.sections[k].title} hint={tp.sections[k].hint}>
              <ul className="pr-grid">
                {group.map((c) => (
                  <li key={c.key}>
                    <Link
                      href={c.href}
                      className="pr-card press"
                      data-preset={c.key}
                      aria-label={fmt(tp.open, { action: tp.actions[c.kind], title: c.title })}
                    >
                      <span className="pr-art" aria-hidden>
                        <PresetArt art={c.art} />
                      </span>
                      <span className="pr-body">
                        <span className="pr-tag">{c.tag}</span>
                        <span className="pr-title">{c.title}</span>
                        <span className="pr-who">{c.who}</span>
                        <span className="pr-go" aria-hidden>
                          {tp.actions[c.kind]}
                          <ArrowRight className="size-3.5 shrink-0" />
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          );
        })
      )}

      <p className="g2-none">{tp.note}</p>
    </div>
  );
}
