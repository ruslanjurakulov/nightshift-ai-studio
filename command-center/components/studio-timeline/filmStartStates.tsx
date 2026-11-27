"use client";

import Link from "next/link";
import { buttonClass } from "@/components/ds/button-class";
import { formatCredits } from "@/lib/credits";
import { fmt } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n/context";
import { pluralForm, type PluralForms } from "@/lib/plural";

// TODO(S5): replace with `@/components/ds/States` once #899 merges. The names and props below are exactly #899's, so the swap is one
// import line in FilmCreateButton.tsx; until then these are the minimal accessible equivalents. Every number is the server's, and a
// null is said as "unknown", never as 0 (rule 5).

/** "Price: 1 credit." / "Цена: 22 кредита.": the form picked by the number, the number printed by formatCredits. */
export function creditsText(forms: PluralForms, n: number, locale: string, vars: Record<string, string | number> = {}): string {
  return fmt(pluralForm(forms, n, locale), { ...vars, n: formatCredits(n, locale) });
}

/** A link or button that is a key: 44 px tall on every pointer, not only a coarse one (Pixel M4). */
export const keyClass = (variant: "primary" | "secondary" | "quiet") => buttonClass({ variant, size: "sm", className: "min-h-11 self-start" });

const box = (compact?: boolean) => (compact ? "flex min-w-0 flex-col gap-1 text-sm" : "flex min-w-0 flex-col gap-2 text-sm");

/** Short of credits: what the quote needs and what the quote read as the balance, then the way to add credits (the primary key). */
export function InsufficientCredits({ needed, available, addCreditsHref, compact }: { needed: number | null; available: number | null; addCreditsHref: string; compact?: boolean }) {
  const { t, locale } = useI18n();
  const c = t.studioTimeline;
  const l = locale ?? "en";
  return (
    <div role="alert" className={box(compact)}>
      <span>{needed !== null ? creditsText(c.create.priceIs, needed, l) : c.create.priceUnknown}</span>
      <span>{available !== null ? creditsText(c.create.balanceIs, available, l) : c.create.balanceUnknown}</span>
      <Link href={addCreditsHref} className={keyClass("primary")}>
        {c.addCredits}
      </Link>
    </div>
  );
}

/** A 401: sign in again, in this tab (#899). Nothing was started, so nothing is lost by leaving. */
export function SessionExpired({ signInHref, compact }: { signInHref: string; draftKept?: boolean; compact?: boolean }) {
  const { t } = useI18n();
  const k = t.studioTimeline.create;
  return (
    <div role="alert" className={box(compact)}>
      <span>{k.sessionExpired}</span>
      <a href={signInHref} className={keyClass("primary")}>
        {k.signIn}
      </a>
    </div>
  );
}

/** The model a line needs is down or off sale. Nothing is substituted (rule 4). A provider name is shown only when it is known. */
export function ProviderUnavailable({ provider, onChooseAnother, onRetry, compact }: { provider: string; onChooseAnother?: () => void; onRetry?: () => void; compact?: boolean }) {
  const { t } = useI18n();
  const c = t.studioTimeline;
  return (
    <div role="alert" className={box(compact)}>
      <span>
        {provider ? `${provider}: ` : ""}
        {c.create.providerDown}
      </span>
      {(onChooseAnother || onRetry) && (
        <span className="flex flex-wrap gap-2">
          {onChooseAnother && (
            <button type="button" className={keyClass("secondary")} onClick={onChooseAnother}>
              {c.create.chooseAnother}
            </button>
          )}
          {onRetry && (
            <button type="button" className={keyClass("quiet")} onClick={onRetry}>
              {c.retry}
            </button>
          )}
        </span>
      )}
    </div>
  );
}
