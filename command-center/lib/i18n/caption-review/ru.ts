import type { CaptionReviewDictionary } from "./en";

/** Проверка субтитров в редакторе. Источник — ./en.ts. */
export const captionReviewRu: CaptionReviewDictionary = {
  title: "Проверка субтитров",
  note: "Только подсказки. Субтитры не изменены.",
  cue: "Субтитр {n}",
  empty: "Добавьте текст субтитра.",
  out_of_order: "Проверьте время, порядок или пересечения.",
  past_end: "Проверьте субтитр относительно конца видео.",
  more: "Ещё субтитров для проверки: {n}.",
};
