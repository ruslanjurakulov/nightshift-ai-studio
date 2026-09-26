import { ArrowUpRight } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import type { ShowcaseItem } from "@/lib/landing";
import { SectionHead } from "@/components/landing/SectionHead";

/**
 * Real videos made with Nightshift. Fed by SHOWCASE in lib/landing.ts, which
 * ships empty — the landing page renders this section only when
 * visibleShowcase() returns something, so there is never a placeholder or
 * mock result on the page. See lib/landing.ts for how to add an entry.
 *
 * Thumbnails are YouTube's own images, loaded lazily from i.ytimg.com; nothing
 * is copied into this repository.
 */
export function Showcase({ t, items, hour }: { t: Dictionary; items: ShowcaseItem[]; hour: string }) {
  const s = t.landing.showcase;
  return (
    <section id="showcase" aria-labelledby="showcase-title" className="scroll-mt-24">
      <SectionHead hour={hour} eyebrow={s.eyebrow} title={s.title} lead={s.lead} id="showcase-title" />
      <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => (
          <li key={it.youtubeId}>
            <a
              href={`https://www.youtube.com/watch?v=${it.youtubeId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="panel group flex h-full flex-col overflow-hidden"
            >
              <span
                className="relative block w-full overflow-hidden bg-[var(--color-panel-2)]"
                style={{ aspectRatio: it.format === "short" ? "9 / 16" : "16 / 9" }}
              >
                {/* A remote thumbnail at its natural size; next/image would need
                    a remotePatterns entry for one optional section. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`https://i.ytimg.com/vi/${it.youtubeId}/hqdefault.jpg`}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="absolute inset-0 size-full object-cover"
                />
                {it.format === "short" && (
                  <span className="mono pill absolute left-3 top-3 bg-[var(--color-bg)] px-2 py-0.5 text-[10px] uppercase tracking-[0.12em]">
                    {s.short}
                  </span>
                )}
              </span>
              <span className="flex flex-1 flex-col gap-1.5 p-5">
                <span className="text-[15px] font-medium leading-snug">{it.title}</span>
                <span className="text-[13px] font-light text-[var(--color-muted)]">{it.channel}</span>
                <span className="mt-auto inline-flex items-center gap-1.5 pt-3 text-[13px] text-[var(--color-primary)]">
                  {s.watch}
                  <ArrowUpRight className="size-3.5" aria-hidden />
                </span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
