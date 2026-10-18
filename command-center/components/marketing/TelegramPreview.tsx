"use client";

import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { buildPreview, mediaKind, type Texts } from "@/lib/marketing-posts";

/**
 * Exactly what the Telegram channel will show for these texts: one message, three labelled language blocks in the
 * fixed order, then the link (lib/marketing-posts.ts buildPreview, a mirror of modules/channel_post.py pinned by a shared
 * fixture), with the length of each language and of the whole message against the limit (4096, or 1024 with a photo or
 * video), counted in UTF-16 units as the sender counts.
 *
 * Read only: it draws the words and the counts; it has no control, and in particular none that sends or tests.
 * Unknown stays unknown: without the site's address the link is left out of the count and the total says "at least".
 */
export function TelegramPreview({
  texts,
  link,
  mediaPath,
  origin,
}: {
  texts: Texts;
  link: string | null;
  mediaPath: string | null;
  origin: string | null;
}) {
  const { t } = useI18n();
  const p = t.marketing.preview;
  const pv = buildPreview(texts, link, origin, Boolean(mediaPath));
  const kind = mediaKind(mediaPath);
  const kindWord = kind === "photo" ? p.mediaPhoto : kind === "video" ? p.mediaVideo : p.mediaOther;

  return (
    <section className="flex flex-col gap-2" aria-label={p.title}>
      <div>
        <h4 className="text-sm font-semibold text-[var(--color-fg)]">{p.title}</h4>
        <p className="text-xs text-[var(--color-muted)]">{p.caption}</p>
      </div>
      <div className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm text-[var(--color-fg)]" data-telegram-preview="">
        {mediaPath && <p className="break-all text-xs text-[var(--color-muted)]">{fmt(p.media, { kind: kindWord, path: mediaPath })}</p>}
        {pv.blocks.map((b) => (
          <div key={b.lang} className="flex flex-col gap-0.5">
            <p className="font-semibold">{b.label}</p>
            <p lang={b.lang} className="whitespace-pre-wrap break-words leading-relaxed">
              {b.text}
            </p>
          </div>
        ))}
        {link && (
          <p className="break-all text-[var(--color-info)]" data-preview-link="">
            {pv.linkUrl ?? fmt(p.linkUncounted, { path: link })}
          </p>
        )}
      </div>
      <ul className="tnum flex flex-col gap-0.5 text-xs text-[var(--color-muted)]" aria-label={p.counts}>
        {pv.blocks.map((b) => (
          <li key={b.lang}>{fmt(p.perLang, { lang: b.label, n: b.units })}</li>
        ))}
        <li className={pv.over ? "font-semibold text-[var(--color-fail)]" : "font-semibold text-[var(--color-fg)]"}>
          {fmt(pv.linkUncounted ? p.totalAtLeast : p.total, { n: pv.total, limit: pv.limit })}
        </li>
        <li>{fmt(mediaPath ? p.limitCaption : p.limitMessage, { limit: pv.limit })}</li>
      </ul>
      {pv.over && (
        <p role="alert" className="text-xs font-medium text-[var(--color-fail)]">
          {p.over}
        </p>
      )}
      <p className="text-xs text-[var(--color-muted)]">{p.note}</p>
    </section>
  );
}
