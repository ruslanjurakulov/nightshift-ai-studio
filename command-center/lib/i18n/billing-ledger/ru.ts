import type { BillingLedgerDictionary } from "./en";

/**
 * Учёт владельца в строке каждого провайдера на странице «Оплата»: сколько куплено, сколько израсходовано (конвейер, Студия,
 * пробы) и сколько осталось. Источник — ./en.ts.
 * ЧЕРНОВИК ПЕРЕВОДА: текст написан не носителем языка и ждёт вычитки носителем.
 */
export const billingLedgerRu: BillingLedgerDictionary = {
  bought: "Куплено",
  boughtNone: "пополнений не записано",
  boughtCount: "пополнений: {n}, первое {date}",
  credits: "кредитов: {n}",
  usedSince: "Израсходовано с {date} (UTC)",
  usedLast30: "Израсходовано за 30 дней",
  left: "Осталось",
  leftReported: "по данным провайдера, {when}",
  leftEstimate: "оценка: куплено минус израсходовано",
  leftUnknown: {
    unread: "неизвестно: данные об оплате не удалось прочитать",
    no_topup: "неизвестно: пополнений не записано, а провайдер баланс не сообщает",
    used_unread: "неизвестно: часть расхода не удалось прочитать",
    used_partial: "неизвестно: история расходов прочитана не полностью",
    used_untracked: "неизвестно: расход конвейера у этого провайдера не записывается",
    used_no_rows: "неизвестно: в журнале конвейера ещё нет строк",
    used_unpriced: "неизвестно: у части расхода нет цены",
    used_may_have_billed: "неизвестно: неудачные пробы могли быть оплачены",
    negative: "неизвестно: израсходовано больше, чем записано пополнений",
  },
  sources: { pipeline: "Конвейер", studio: "Студия", probes: "Пробы" },
  state: {
    unread: "не удалось прочитать",
    untracked: "не записывается",
    notUsed: "не используется",
    none: "нет",
    noRows: "строк пока нет",
    partial: "история прочитана не полностью",
  },
  atLeast: "не меньше {usd}",
  estimate: "оценка",
  usdUnknown: "{qty} {unit}, цена в USD неизвестна",
  rowsUsdUnknown: "{unit}: строк {n}, цена в USD неизвестна",
  billingUnknown: "неудачных проб, которые могли быть оплачены: {n}",
  // The vendor-named units (gemini_*, pexels_*) are in lib/server/ledger-unit-labels.ts: this dictionary ships to the browser.
  units: {
    second: "с",
    image: "изобр.",
    character: "симв.",
    request: "запр.",
    credits: "кредитов",
    tokens: "токенов",
    probe: "проб",
    tts_characters: "симв.",
    video_gen_clips: "клипов",
    image_generations: "изобр.",
  },
  pipelineLastDay: "Конвейер, последний {n} дн.",
  pipelineLastDays: "Конвейер, последние {n} дн.",
  pipeline30: "Конвейер, 30 дней",
  headlinePipelineOnly: "только конвейер: Студия и пробы — в строке каждого провайдера",
  noBillingLink: "страница оплаты не проверена",
};
