/**
 * Who operates Nightshift, for the public Privacy Policy and Terms of Service.
 *
 * These are facts about a legal person, and nobody in this repository can know
 * them — so none are defaulted. A policy that names an invented company, or an
 * effective date that silently reads "today", would be a published statement
 * that is simply false. Each value comes from a public env var, and one that is
 * missing or malformed stays `null` so the page renders a visible NOT
 * CONFIGURED marker instead (the same rule as a hidden subscriber count: an
 * unknown is never rendered as if it were a value).
 *
 * Public (`NEXT_PUBLIC_*`) on purpose: the values are printed on public pages
 * anyway, and the footer that shows them is a client component.
 *
 *   NEXT_PUBLIC_LEGAL_NAME            legal name of the operator (person or company)
 *   NEXT_PUBLIC_CONTACT_EMAIL         privacy / support contact address
 *   NEXT_PUBLIC_LEGAL_COUNTRY         country whose law governs the Terms
 *   NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE  YYYY-MM-DD the current texts took effect
 */

export interface LegalEnv {
  NEXT_PUBLIC_LEGAL_NAME?: string;
  NEXT_PUBLIC_CONTACT_EMAIL?: string;
  NEXT_PUBLIC_LEGAL_COUNTRY?: string;
  NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE?: string;
}

export interface LegalConfig {
  legalName: string | null;
  contactEmail: string | null;
  country: string | null;
  /** ISO date, YYYY-MM-DD. */
  effectiveDate: string | null;
}

export type LegalField = keyof LegalConfig;

/** Env var behind each field — shown next to the NOT CONFIGURED marker so the
 *  owner reading the page knows exactly what to set. */
export const LEGAL_ENV_VARS: Record<LegalField, keyof LegalEnv> = {
  legalName: "NEXT_PUBLIC_LEGAL_NAME",
  contactEmail: "NEXT_PUBLIC_CONTACT_EMAIL",
  country: "NEXT_PUBLIC_LEGAL_COUNTRY",
  effectiveDate: "NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE",
};

function text(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  return v ? v : null;
}

/** A contact address a reader could actually write to. Anything else is treated
 *  as unset: a typo'd address on a privacy policy is a dead end for the person
 *  trying to exercise their rights. */
function email(raw: string | undefined): string | null {
  const v = text(raw);
  return v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

/** A real calendar date in YYYY-MM-DD. `2026-02-31` is rejected rather than
 *  rolled over into March. */
function isoDate(raw: string | undefined): string | null {
  const v = text(raw);
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

export function readLegalConfig(env: LegalEnv): LegalConfig {
  return {
    legalName: text(env.NEXT_PUBLIC_LEGAL_NAME),
    contactEmail: email(env.NEXT_PUBLIC_CONTACT_EMAIL),
    country: text(env.NEXT_PUBLIC_LEGAL_COUNTRY),
    effectiveDate: isoDate(env.NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE),
  };
}

/** The fields still missing — the owner's to-do list before submitting the app
 *  for Google's OAuth verification. */
export function missingLegalFields(config: LegalConfig): LegalField[] {
  return (Object.keys(LEGAL_ENV_VARS) as LegalField[]).filter((k) => config[k] === null);
}

// Each variable is read by its literal name: Next.js inlines NEXT_PUBLIC_* into
// the client bundle only for a direct, literally named env reference, so passing
// the whole env object would leave the footer blank in the browser.
export const LEGAL: LegalConfig = readLegalConfig({
  NEXT_PUBLIC_LEGAL_NAME: process.env.NEXT_PUBLIC_LEGAL_NAME,
  NEXT_PUBLIC_CONTACT_EMAIL: process.env.NEXT_PUBLIC_CONTACT_EMAIL,
  NEXT_PUBLIC_LEGAL_COUNTRY: process.env.NEXT_PUBLIC_LEGAL_COUNTRY,
  NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: process.env.NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE,
});

/**
 * How long purchased credits stay usable, for the Terms and the Pricing page.
 *
 *   NEXT_PUBLIC_CREDITS_EXPIRY_MONTHS  whole months, 1–120; empty = credits do not expire
 *
 * Unlike the operator details above, empty is a real answer here, not a gap:
 * nothing in the Service expires credits (0020 expires only the hold on a run
 * that never reported back), so the texts say credits do not expire until the
 * operator decides otherwise and sets a term. A value that is not a whole
 * number in range is treated as unset, so the texts keep describing what the
 * system actually does rather than a typo.
 */
export function creditExpiryMonths(raw: string | undefined): number | null {
  const v = (raw ?? "").trim();
  if (!/^\d{1,3}$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 120 ? n : null;
}

export const CREDIT_EXPIRY_MONTHS: number | null = creditExpiryMonths(process.env.NEXT_PUBLIC_CREDITS_EXPIRY_MONTHS);
