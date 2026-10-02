import type { Locale } from "@/lib/i18n";

/**
 * The few sentences the Atelier concept heroes need that the public site's
 * dictionary does not already have (lib/concepts.ts). Everything else on a
 * concept is read from `t.site.*`, so the copy a visitor would read is the
 * copy the live page already ships, in the same three languages.
 *
 * The prototype strip (the line above the hero that says this is not the live
 * page) is engineering chrome, English only, and is not in this file.
 *
 * Uzbek uses ʻ (U+02BB) and ʼ (U+02BC), never the ASCII apostrophe
 * (tests/uz-apostrophes.test.ts).
 */
export interface ConceptCopy {
  /** Concept A's rack, read as one image: what it shows. */
  rackFigure: string;
  /** Concept A's step ladder, for assistive technology. */
  ladder: string;
  /** Concept A's rack column heads. */
  rackHeads: { rundown: string; rules: string; approval: string };
  /** Concept B's ledger, read as one image. */
  ledgerFigure: string;
  /** Concept B's last ledger line: where the person signs. */
  signLabel: string;
  /** Concept C's screen, read as one image. */
  screenFigure: string;
  /** Concept C's list of verdicts under the player. */
  verdicts: string;
}

export const conceptCopy: Record<Locale, ConceptCopy> = {
  en: {
    rackFigure:
      "Illustration of a control-room rack for one video: the six steps in order with the first four done and the fifth, your approval, waiting; the three rules the product keeps, lit; and the Approve key.",
    ladder: "Steps done: four of six, the fifth is yours",
    rackHeads: { rundown: "Rundown", rules: "Rules kept", approval: "Approval" },
    ledgerFigure:
      "Illustration of a ledger with three entries: the price comes first, a failure costs nothing, nothing airs without you. The last line, your approval, is open.",
    signLabel: "Your approval",
    screenFigure:
      "Illustration of the screen a finished video waits on: a player showing a drawn scene, its timeline with three clips, a text track and a music track, the publish check passed, private on YouTube, auto-publish off, and the Approve key. Everything on it is an example.",
    verdicts: "Before it goes public",
  },
  ru: {
    rackFigure:
      "Иллюстрация: пульт одного видео. Шесть шагов по порядку: первые четыре готовы, пятый — ваше одобрение — ждёт; три соблюдаемых правила горят; кнопка «Одобрить».",
    ladder: "Шагов готово: четыре из шести, пятый за вами",
    rackHeads: { rundown: "Выпуск", rules: "Правила", approval: "Одобрение" },
    ledgerFigure:
      "Иллюстрация: журнал из трёх записей. Сначала цена, сбой ничего не стоит, без вас в эфир ничего не выйдет. Последняя строка, ваше одобрение, ещё не закрыта.",
    signLabel: "Ваше одобрение",
    screenFigure:
      "Иллюстрация: экран, на котором ждёт готовое видео. Плеер с нарисованной сценой, дорожки монтажа с тремя клипами, текстом и музыкой, проверка перед публикацией пройдена, видео приватное на YouTube, автопубликация выключена, кнопка «Одобрить». Всё на экране — пример.",
    verdicts: "До выхода в эфир",
  },
  uz: {
    rackFigure:
      "Rasm: bitta video uchun boshqaruv paneli. Oltita qadam tartib bilan: dastlabki toʻrttasi tayyor, beshinchisi — sizning tasdigʻingiz — kutmoqda; mahsulot rioya qiladigan uchta qoida yonib turibdi; «Tasdiqlash» tugmasi.",
    ladder: "Tayyor qadamlar: oltitadan toʻrttasi, beshinchisi sizda",
    rackHeads: { rundown: "Efir rejasi", rules: "Qoidalar", approval: "Tasdiq" },
    ledgerFigure:
      "Rasm: uchta yozuvli daftar. Avval narx, xato hech narsaga tushmaydi, sizsiz hech narsa efirga chiqmaydi. Oxirgi satr — sizning tasdigʻingiz — hali ochiq.",
    signLabel: "Sizning tasdigʻingiz",
    screenFigure:
      "Rasm: tayyor video kutayotgan ekran. Chizilgan sahnali pleyer, uchta klip, matn va musiqa yoʻlaklari bilan montaj chizigʻi, nashr oldidan tekshiruv oʻtgan, video YouTube’da shaxsiy, avtonashr oʻchiq, «Tasdiqlash» tugmasi. Ekrandagi hamma narsa — namuna.",
    verdicts: "Ommaga chiqishdan oldin",
  },
};
