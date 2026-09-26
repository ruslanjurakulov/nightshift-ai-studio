/**
 * The shape of the Privacy Policy and Terms of Service, in every language.
 *
 * They live outside `lib/i18n/{en,ru,uz}.ts` on purpose. Those dictionaries are
 * imported by the client-side I18nProvider, so every string in them ships in
 * the JavaScript of every dashboard screen; two full legal documents in three
 * languages would have been dead weight on all of them. These modules are read
 * only by the Server Components that render /privacy and /terms, and the
 * `LegalTexts` type keeps the three languages key-for-key in step exactly as
 * `Dictionary` does for the dictionaries.
 *
 * Inline markup inside any string (see ./inline.ts):
 *   [label](https://…) or [label](/path)  a link
 *   {legalName} {contactEmail} {country} {effectiveDate}  operator details from lib/legal.ts
 *   `text`  code, used for OAuth scope names
 */

export type LegalBlock =
  | string
  | { list: string[] }
  | { table: { head: string[]; rows: string[][] } }
  /** A boxed notice — e.g. that a section still awaits a lawyer's review. */
  | { note: string }
  /**
   * The one sentence that depends on NEXT_PUBLIC_CREDITS_EXPIRY_MONTHS
   * (lib/legal.ts): `never` while no term is set — nothing in the Service
   * expires credits — and `after`, with `{months}` filled in, once one is.
   */
  | { creditExpiry: { never: string; after: string } };

export interface LegalSection {
  /** Stable anchor, identical across languages so a deep link survives a switch. */
  id: string;
  heading: string;
  body: LegalBlock[];
}

export interface LegalDocument {
  title: string;
  summary: string;
  sections: LegalSection[];
}

export interface LegalTexts {
  privacy: LegalDocument;
  terms: LegalDocument;
}
