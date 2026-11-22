"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";

// TODO(S5): replace with `@/components/ds/States` once #899 merges. The names and props below are exactly #899's, so the swap is one
// import line in FilmCreateButton.tsx; until then these are the minimal accessible equivalents. Every number is the server's, and a
// null is said as "unknown", never as 0 (rule 5).

const LINK = "underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
const box = (compact?: boolean) => (compact ? "flex min-w-0 flex-col gap-1 text-sm" : "flex min-w-0 flex-col gap-2 text-sm");

/** Short of credits: what the quote needs and what the quote read as the balance, then the way to add credits. */
export function InsufficientCredits({ needed, available, addCreditsHref, compact }: { needed: number | null; available: number | null; addCreditsHref: string; compact?: boolean }) {
  const { t, fmt } = useI18n();
  const c = t.studioTimeline;
  return (
    <div role="alert" className={box(compact)}>
      <span>{needed !== null ? fmt(c.create.priceIs, { n: needed }) : c.create.priceUnknown}</span>
      <span>{available !== null ? fmt(c.create.balanceIs, { n: available }) : c.create.balanceUnknown}</span>
      <Link href={addCreditsHref} className={LINK}>
        {c.addCredits}
      </Link>
    </div>
  );
}

/** A 401: sign in again (in a new tab, so what is on this screen stays). */
export function SessionExpired({ signInHref, draftKept, compact }: { signInHref: string; draftKept?: boolean; compact?: boolean }) {
  const { t } = useI18n();
  const k = t.studioTimeline.create;
  return (
    <div role="alert" className={box(compact)}>
      <span>{draftKept ? k.sessionExpired : k.sessionExpiredBare}</span>
      <a href={signInHref} target="_blank" rel="noopener" className={LINK}>
        {k.signIn}
      </a>
    </div>
  );
}

/** The model a line needs is down or off sale. Nothing is substituted (rule 4). */
export function ProviderUnavailable({ provider, onChooseAnother, onRetry, compact }: { provider: string; onChooseAnother?: () => void; onRetry?: () => void; compact?: boolean }) {
  const { t, fmt } = useI18n();
  const c = t.studioTimeline;
  return (
    <div role="alert" className={box(compact)}>
      <span>{c.create.providerDown}</span>
      <span>{fmt(c.create.providerIs, { name: provider || c.unknown })}</span>
      {(onChooseAnother || onRetry) && (
        <span className="flex flex-wrap gap-2">
          {onRetry && (
            <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={onRetry}>
              {c.retry}
            </button>
          )}
          {onChooseAnother && (
            <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={onChooseAnother}>
              {c.create.chooseAnother}
            </button>
          )}
        </span>
      )}
    </div>
  );
}
