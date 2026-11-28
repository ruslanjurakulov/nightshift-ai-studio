import "server-only";
import type { Locale } from "@/lib/i18n/core";
import { priceEnvVar } from "@/lib/unitEconomics";

/**
 * The operator's instruction for an unpriced cost, naming the variable that prices it (CHRONOS_PRICE_<UNIT>), in en and ru.
 *
 * Server-only: these sentences were in the shared dictionary (ops.advSpendOvUnpriced, measure.unpricedHint,
 * portfolio.notConfigured), and that dictionary is a static chunk every signed-in page loads, a customer's included. The
 * variable is our pipeline's per-unit cost configuration, not something a customer can set. The dictionary now says only that
 * some costs are not priced yet (unknown stays unknown, CLAUDE.md rule 5); a page that has checked isOperator() shows these.
 * Like lib/server/ledger-unit-labels.ts, the one other place dashboard words live outside lib/i18n/{en,ru,uz}.ts, and for the
 * same reason.
 */
export interface PriceConfigHints {
  /** The spend overview card on Intelligence (AdvisoryPanel). */
  spendOverview: string;
  /** The "units with no configured rate" panel on Measurement, above which the variables are listed. */
  measure: string;
  /** Portfolio with no cost or revenue recorded yet. */
  portfolio: string;
}

const VAR = priceEnvVar("<unit>");

// No Uzbek entry, on purpose: the owner reads Uzbek, and his copy says "ask the developer" in words instead of naming a variable
// (tests/owner-plain-copy.test.ts pins that). An Uzbek page keeps the dictionary's sentence.
const HINTS: Partial<Record<Locale, PriceConfigHints>> = {
  en: {
    spendOverview: `Some costs are quantities only — set ${VAR} for each unit and the dollar figures fill in. Until then they read as unknown, not zero.`,
    measure: `Quantities are measured; the price is not. Set ${VAR} for each unit below and the dollar figures fill in. Until then a cost reads as unknown rather than as a number nobody verified.`,
    portfolio: `No cost or revenue recorded yet. Costs are written as videos finish a run (and need ${VAR} rates to price); revenue arrives once the channel is in the Partner Program and the monetary scope is granted.`,
  },
  ru: {
    spendOverview: `Часть расходов — только количества. Задайте ${VAR} для каждой единицы, и суммы появятся. До этого они показаны как неизвестные, а не как ноль.`,
    measure: `Количество измерено, цена — нет. Задайте ${VAR} для каждой единицы ниже, и суммы появятся. До этого стоимость показана как неизвестная, а не как непроверенное число.`,
    portfolio: `Пока нет записанных затрат или дохода. Затраты записываются по мере завершения видео (и требуют ставок ${VAR} для оценки); доход появляется, когда канал в Партнёрской программе и предоставлен монетарный доступ.`,
  },
};

/** The operator's sentences in `locale`, or null where the dictionary's own sentence is the one to show (Uzbek). */
export function priceConfigHints(locale: Locale): PriceConfigHints | null {
  return HINTS[locale] ?? null;
}
