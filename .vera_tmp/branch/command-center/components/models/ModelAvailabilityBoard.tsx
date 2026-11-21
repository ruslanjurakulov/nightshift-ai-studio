"use client";

import { postOperator } from "@/lib/operator-post";
import { operatorFailureText } from "@/lib/setup-errors";
import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { relativeTime } from "@/lib/format";
import { formatCredits } from "@/lib/credits";
import { useChannelPath } from "@/lib/channels-client";
import { useToast } from "@/components/feedback/ToastProvider";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { Chip } from "@/components/ui/Chip";
import { SegmentedSwitch } from "@/components/ui/SegmentedSwitch";
import {
  AVAILABILITIES,
  availabilityBlocker,
  isOnSale,
  type AdminModel,
  type Availability,
  type Blocker,
  type ProbeSummary,
} from "@/lib/models-admin";

/**
 * The operator's model list (migration 0035), one card per model, phone first:
 * who makes it, what it does, whether a real call has proved it, its price,
 * and a four-way availability switch. Beta and GA stay disabled while the
 * database would refuse them (no probe, vendor terms open, no credit unit),
 * with the reason on the card — the route and the CHECKs refuse them anyway.
 */
export function ModelAvailabilityBoard({
  models,
  probes,
  prices,
}: {
  models: AdminModel[];
  /** Newest probe per model; null when the probe log could not be read. */
  probes: Record<string, ProbeSummary> | null;
  /** credits_per_unit by unit; null when the price list could not be read. */
  prices: Record<string, number> | null;
}) {
  const { t } = useI18n();
  const onSale = models.filter((m) => isOnSale(m.availability)).length;
  return (
    <div className="flex flex-col gap-4">
      <p className="g2-note tnum">{fmt(t.models.count, { n: models.length, sale: onSale })}</p>
      {probes === null && <p className="g2-warn">{t.models.probesFailed}</p>}
      <section className="ns-desk g2-desk g2-wizard" aria-label={t.models.title}>
        <div className="g2-models">
          {models.map((m) => (
            <ModelCard key={m.id} model={m} probe={probes?.[m.id] ?? null} probesRead={probes !== null} prices={prices} />
          ))}
        </div>
      </section>
    </div>
  );
}

const TONE: Record<Availability, "ok" | "run" | "idle" | "fail"> = { ga: "ok", beta: "run", hidden: "idle", disabled: "fail" };

function ModelCard({
  model,
  probe,
  probesRead,
  prices,
}: {
  model: AdminModel;
  probe: ProbeSummary | null;
  probesRead: boolean;
  prices: Record<string, number> | null;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const path = useChannelPath();
  const warnId = useId();
  const [availability, setAvailability] = useState<Availability>(model.availability);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const label = (a: Availability): string =>
    ({ hidden: t.models.avail_hidden, beta: t.models.avail_beta, ga: t.models.avail_ga, disabled: t.models.avail_disabled })[a];
  const blockerText: Record<Blocker, string> = {
    not_verified: t.models.err_not_verified,
    terms_gate: t.models.err_terms_gate,
    no_credit_unit: t.models.err_no_credit_unit,
  };
  const errorText = (code: unknown): string => {
    if (code === "not_verified" || code === "terms_gate" || code === "no_credit_unit") return blockerText[code];
    if (code === "forbidden" || code === "unauthorized") return t.models.err_forbidden;
    if (code === "rejected") return t.models.err_rejected;
    return t.models.err_failed;
  };

  async function change(to: Availability) {
    if (busy || to === availability) return;
    const blocker = availabilityBlocker(model, to);
    if (blocker) {
      setError(errorText(blocker));
      return;
    }
    setBusy(true);
    setError(null);
    const out = await postOperator("/api/models/availability", { id: model.id, availability: to });
    setBusy(false);
    if (!out.ok) {
      // A session that ended, a missing second step or no connection say so; the route's own refusals keep their words.
      const msg =
        out.kind === "session" || out.kind === "network" || out.kind === "mfa" || out.kind === "mfa_enrol"
          ? operatorFailureText(t, out, t.models.err_failed)
          : errorText(out.data.error);
      setError(msg);
      toast.error(msg, { title: model.displayName });
      return;
    }
    setAvailability(to);
    toast.success(fmt(t.models.saved, { model: model.displayName, availability: label(to) }), { title: model.displayName });
    router.refresh();
  }

  const price = model.creditUnit && prices ? prices[model.creditUnit] : undefined;
  const warnings: string[] = [];
  if (!model.verifiedAt) warnings.push(t.models.unverifiedWarning);
  if (model.termsGate) warnings.push(fmt(t.models.termsGate, { gate: model.termsGate }));
  if (!model.creditUnit) warnings.push(t.models.noUnit);
  if (model.removedFromFile) warnings.push(t.models.removed);

  return (
    <article className="g2-model" aria-labelledby={`${warnId}-name`}>
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={`${warnId}-name`} className="g2-h3 truncate">
              {model.displayName}
            </h2>
            <p className="mono truncate text-[13px] text-[var(--color-muted)]">{model.id}</p>
          </div>
          <StatusLamp tone={TONE[availability]} label={label(availability)} live={availability === "ga"} />
        </div>

        <dl className="g2-defs">
          <dt>{t.models.provider}</dt>
          <dd className="tnum min-w-0 truncate">{model.provider}</dd>

          <dt>{t.models.capabilities}</dt>
          <dd className="flex min-w-0 flex-wrap gap-1.5">
            {model.capabilities.map((c) => (
              <Chip key={c} plain>
                {c}
              </Chip>
            ))}
          </dd>

          <dt>{t.models.lastProbe}</dt>
          <dd className="min-w-0">
            {model.verifiedAt ? (
              <span className="g2-ok block">{fmt(t.models.verified, { when: relativeTime(model.verifiedAt, locale) })}</span>
            ) : (
              <span className="g2-warn block">{t.models.notVerified}</span>
            )}
            {probesRead && (
              <span className="tnum block text-[13px] text-[var(--color-muted)]">
                {probe
                  ? probe.ok
                    ? fmt(t.models.probeOk, { when: relativeTime(probe.at, locale) })
                    : fmt(t.models.probeFailed, { when: relativeTime(probe.at, locale), code: probe.errorCode ?? "—" })
                  : t.models.noProbe}
              </span>
            )}
          </dd>

          <dt>{t.models.price}</dt>
          <dd className="min-w-0">
            {model.creditUnit ? (
              prices === null ? (
                <span className="g2-warn">{t.models.pricesFailed}</span>
              ) : price !== undefined && price > 0 ? (
                <span className="tnum">
                  {fmt(t.models.priceRow, { credits: formatCredits(price, locale), unit: model.creditUnit })}
                </span>
              ) : (
                <span className="g2-warn">{fmt(t.models.unpriced, { unit: model.creditUnit })}</span>
              )
            ) : (
              <span className="text-[var(--color-muted)]">—</span>
            )}
            {model.creditUnit && (
              <Link href={`${path("/credits")}#credit-prices`} className="tap-link g2-link block text-sm">
                {t.models.editPrice} →
              </Link>
            )}
          </dd>

          {model.entitlement && (
            <>
              <dt>{t.models.entitlement}</dt>
              <dd className="tnum min-w-0 truncate">{model.entitlement}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        {warnings.length > 0 && (
          <div id={`${warnId}-warn`} className="flex flex-col gap-1.5 border-l-2 border-[var(--color-warn)] pl-3" role="note">
            {warnings.map((w) => (
              <p key={w} className="g2-warn flex items-start gap-2 !text-[0.875rem] leading-snug">
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                <span>{w}</span>
              </p>
            ))}
          </div>
        )}

        <fieldset className="flex flex-col gap-2" disabled={busy}>
          <legend className="g2-label mb-2">{busy ? t.models.saving : t.models.availability}</legend>
          <SegmentedSwitch
            label={t.models.availability}
            size="lg"
            className="w-full [&>button]:flex-1 [&>button]:justify-center"
            value={availability}
            onChange={(a) => void change(a)}
            options={AVAILABILITIES.map((a) => ({ value: a, label: label(a), disabled: a !== availability && availabilityBlocker(model, a) !== null }))}
          />
        </fieldset>

        {error && (
          <p className="g2-fail" aria-live="polite">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
