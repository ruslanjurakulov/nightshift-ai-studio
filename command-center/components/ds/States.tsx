"use client";

import Link from "next/link";
import { useTransition } from "react";
import { usePublicI18n } from "@/lib/i18n/public-context";
import { formatCredits } from "@/lib/credits";
import { StateBlock } from "@/components/states/StateBlock";
import { buttonClass } from "@/components/ds/button-class";

/**
 * The three states every stream needs and none had a shared form for (docs/design/S5_BENCHMARK.md gap 1,
 * docs/design/SYSTEM.md §6). Each is a StateBlock — the same lamp, title, one line and one way forward as the empty and
 * error states already shared — so a screen never draws its own. They hold no strings: the words are in lib/i18n `common`,
 * and every number is passed in from the server.
 */

/**
 * The backend priced a job above the balance. `needed` and `available` are the server's numbers; a null one reads "unknown"
 * rather than a figure the client made up (rule 5), and the state never computes a shortfall itself.
 */
export function InsufficientCredits({
  needed,
  available,
  addCreditsHref,
  compact = false,
}: {
  needed: number | null;
  available: number | null;
  addCreditsHref: string;
  compact?: boolean;
}) {
  const { t, fmt, locale } = usePublicI18n();
  const n = (v: number | null) => (v === null ? t.common.unknown : formatCredits(v, locale));
  return (
    <StateBlock
      role="alert"
      tone="warn"
      compact={compact}
      title={t.common.noCreditsTitle}
      data-state="insufficient-credits"
      actions={
        <Link href={addCreditsHref} className={buttonClass({ variant: "primary", size: "sm" })}>
          {t.common.noCreditsAdd}
        </Link>
      }
    >
      <span className="ds-num">{fmt(t.common.noCreditsBody, { needed: n(needed), available: n(available) })}</span>
    </StateBlock>
  );
}

/**
 * The model or voice a job is set to did not answer. Rule 4: the run stops; this state says so and offers only choices the
 * person makes — another option by their own hand, or a retry. There is deliberately no prop that picks a substitute.
 */
export function ProviderUnavailable({
  provider,
  onChooseAnother,
  onRetry,
  compact = false,
}: {
  /** The display name of the model or voice, already translated where it has a translation. */
  provider: string;
  onChooseAnother?: () => void;
  onRetry?: () => void | Promise<void>;
  compact?: boolean;
}) {
  const { t, fmt } = usePublicI18n();
  const [pending, start] = useTransition();
  return (
    <StateBlock
      role="alert"
      tone="fail"
      compact={compact}
      title={fmt(t.common.providerDownTitle, { provider })}
      data-state="provider-unavailable"
      actions={
        onChooseAnother || onRetry ? (
          <>
            {onChooseAnother ? (
              <button type="button" className={buttonClass({ variant: "secondary", size: "sm" })} onClick={onChooseAnother}>
                {t.common.providerDownChoose}
              </button>
            ) : null}
            {onRetry ? (
              <button
                type="button"
                className={buttonClass({ variant: "quiet", size: "sm" })}
                aria-busy={pending || undefined}
                onClick={() => {
                  if (!pending) start(async () => void (await onRetry()));
                }}
              >
                {pending ? t.common.retrying : t.common.retry}
              </button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {t.common.providerDownBody}
    </StateBlock>
  );
}

/**
 * The session ended. `draftKept` is true only when the caller actually holds the person's work (a local draft it will
 * restore); otherwise the state does not promise it.
 */
export function SessionExpired({
  signInHref,
  draftKept = false,
  compact = false,
}: {
  signInHref: string;
  draftKept?: boolean;
  compact?: boolean;
}) {
  const { t } = usePublicI18n();
  return (
    <StateBlock
      role="alert"
      tone="warn"
      compact={compact}
      title={t.common.sessionExpiredTitle}
      data-state="session-expired"
      actions={
        <Link href={signInHref} className={buttonClass({ variant: "primary", size: "sm" })}>
          {t.common.sessionExpiredSignIn}
        </Link>
      }
    >
      {draftKept ? t.common.sessionExpiredKept : t.common.sessionExpiredBody}
    </StateBlock>
  );
}
