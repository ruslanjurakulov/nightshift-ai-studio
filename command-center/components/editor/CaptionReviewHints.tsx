"use client";

import type { Cue } from "@/lib/captions";
import { reviewCaptions } from "@/lib/captionReview";
import { useI18n } from "@/lib/i18n/context";

const COPY = {
  en: { title: "Caption review", note: "Suggestions only. Captions are unchanged.", cue: "Caption {n}", empty: "Add caption text.", out_of_order: "Check timing, order or overlaps.", past_end: "Check the caption against the picture’s end.", more: "{n} more captions to review." },
  ru: { title: "Проверка субтитров", note: "Только подсказки. Субтитры не изменены.", cue: "Субтитр {n}", empty: "Добавьте текст субтитра.", out_of_order: "Проверьте время, порядок или пересечения.", past_end: "Проверьте субтитр относительно конца видео.", more: "Ещё субтитров для проверки: {n}." },
  uz: { title: "Subtitrlarni tekshirish", note: "Faqat tavsiyalar. Subtitrlar oʻzgarmadi.", cue: "Subtitr {n}", empty: "Subtitr matnini kiriting.", out_of_order: "Vaqt, tartib yoki ustma-ust kelishni tekshiring.", past_end: "Subtitrni tasvir oxiriga nisbatan tekshiring.", more: "Yana {n} ta subtitrni tekshirish kerak." },
} as const;

/** Read-only advice outside the preview picture; never repairs or gates export. */
export function CaptionReviewHints({ cues, pictureEnd }: { cues: readonly Cue[]; pictureEnd: number }) {
  const { locale, fmt } = useI18n();
  const copy = COPY[locale];
  const flags = reviewCaptions(cues, pictureEnd);
  if (!flags.length) return null;
  return (
    <aside aria-label={copy.title} className="text-xs text-[var(--color-muted)]">
      <p className="m-0 font-medium">{copy.title}</p>
      <p className="m-0">{copy.note}</p>
      <ul className="m-0 pl-4">
        {flags.slice(0, 5).map((flag) => (
          <li key={flag.index}>
            {fmt(copy.cue, { n: flag.index + 1 })}: {flag.reasons.map((reason) => copy[reason]).join(" ")}
          </li>
        ))}
      </ul>
      {flags.length > 5 ? <p className="m-0">{fmt(copy.more, { n: flags.length - 5 })}</p> : null}
    </aside>
  );
}
