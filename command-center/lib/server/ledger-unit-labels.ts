import "server-only";
import type { Locale } from "@/lib/i18n/core";
import { VENDOR_NAMED_LEDGER_UNITS, type VendorNamedLedgerUnit } from "@/lib/server/ledger-units";

/**
 * The words for the ledger units whose names carry a vendor (gemini_input_tokens, pexels_requests, ...), in en/ru/uz.
 *
 * Server-only: they were keys of the shared dictionary (unitEconomics.units, billingLedger.units), and that dictionary is a
 * static chunk loaded by every signed-in page. The Billing page resolves them here and hands the two client panels the pairs
 * as props (UnitLabels); the rest of those tables, which names no vendor, stays in the dictionary.
 *
 *   long:    the label a cost driver is shown with (UnitEconomicsCard), "LLM input tokens";
 *   measure: the word after a quantity (BillingBoard), "tokens". A unit with no measure word shows its name, as before.
 */
type Labels = { long: Record<VendorNamedLedgerUnit, string>; measure: Partial<Record<VendorNamedLedgerUnit, string>> };

const LABELS: Record<Locale, Labels> = {
  en: {
    long: { gemini_input_tokens: "LLM input tokens", gemini_output_tokens: "LLM output tokens", pexels_requests: "Stock media requests" },
    measure: { gemini_input_tokens: "tokens", gemini_output_tokens: "tokens" },
  },
  ru: {
    long: { gemini_input_tokens: "Входные токены LLM", gemini_output_tokens: "Выходные токены LLM", pexels_requests: "Запросы стоковых медиа" },
    measure: { gemini_input_tokens: "токенов", gemini_output_tokens: "токенов" },
  },
  uz: {
    long: { gemini_input_tokens: "LLM kirish tokenlari", gemini_output_tokens: "LLM chiqish tokenlari", pexels_requests: "Stok media soʻrovlari" },
    measure: { gemini_input_tokens: "token", gemini_output_tokens: "token" },
  },
};

/** unit -> words, for a Client Component's props. Only the vendor-named units; the dictionary has the others. */
export type UnitLabels = Readonly<Record<string, string>>;

export function ledgerUnitLabels(locale: Locale, form: keyof Labels): UnitLabels {
  const table = (LABELS[locale] ?? LABELS.en)[form] as Partial<Record<string, string>>;
  const out: Record<string, string> = {};
  for (const u of VENDOR_NAMED_LEDGER_UNITS) {
    const v = table[u];
    if (v) out[u] = v;
  }
  return out;
}
