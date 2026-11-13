import { fmt } from "@/lib/i18n/core";

/** A count's wording in every form a reader's language uses: en one/other, ru one/few/many, uz one form for all. */
export type PluralForms = Record<"one" | "few" | "many" | "other", string>;

/**
 * "1 character" / "2 characters", "2 героя" / "5 героев": the form Intl.PluralRules picks for `n`, with {n} filled. A "(s)" left to
 * the reader is what this replaces. An unknown locale tag falls back to the general form, which reads correctly in every dictionary.
 */
export function pluralText(forms: PluralForms, n: number, locale: string): string {
  let rule: Intl.LDMLPluralRule = "other";
  try {
    rule = new Intl.PluralRules(locale).select(n);
  } catch {
    // keep "other"
  }
  const form = rule === "one" || rule === "few" || rule === "many" ? forms[rule] : forms.other;
  return fmt(form, { n });
}
