"use client";

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
import { TileGrid } from "@/components/ui/ContactSheet";
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
    <div className="flex flex-col gap-3">
      <p className="tnum text-xs text-[var(--color-muted)]">{fmt(t.models.count, { n: models.length, sale: onSale })}</p>
      {probes === null && <p className="text-xs text-[var(--color-warn)]">{t.models.probesFailed}</p>}
      <TileGrid as="div" min={320} label={t.models.title}>
        {models.map((m) => (
          <ModelCard key={m.id} model={m} probe={probes?.[m.id] ?? null} probesRead={probes !== null} prices={prices} />
        ))}
      </TileGrid>
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
    try {
      const res = await fetch("/api/models/availability", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: model.id, availability: to }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: unknown };
      if (!res.ok) {
        const msg = errorText(data.error);
        setError(msg);
        toast.error(msg, { title: model.displayName });
        return;
      }
      setAvailability(to);
      toast.success(fmt(t.models.saved, { model: model.displayName, availability: label(to) }), { title: model.displayName });
      router.refresh();
    } catch {
      setError(t.models.err_failed);
      toast.error(t.models.err_failed, { title: model.displayName });
    } finally {
      setBusy(false);
    }
  }

  const price = model.creditUnit && prices ? prices[model.creditUnit] : undefined;
  const warnings: string[] = [];
  if (!model.verifiedAt) warnings.push(t.models.unverifiedWarning);
  if (model.termsGate) warnings.push(fmt(t.models.termsGate, { gate: model.termsGate }));
  if (!model.creditUnit) warnings.push(t.models.noUnit);
  if (model.removedFromFile) warnings.push(t.models.removed);

  return (
    <article className="panel flex min-w-0 flex-col gap-3 p-5 sm:p-6" aria-labelledby={`${warnId}-name`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={`${warnId}-name`} className="truncate text-sm font-semibold text-[var(--color-fg)]">
            {model.displayName}
          </h2>
          <p className="mono truncate text-xs text-[var(--color-muted)]">{model.id}</p>
        </div>
        <StatusLamp tone={TONE[availability]} label={label(availability)} live={availability === "ga"} />
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-[var(--color-muted)]">{t.models.provider}</dt>
        <dd className="tnum min-w-0 truncate text-[var(--color-fg)]">{model.provider}</dd>

        <dt className="text-[var(--color-muted)]">{t.models.capabilities}</dt>
        <dd className="flex min-w-0 flex-wrap gap-1">
          {model.capabilities.map((c) => (
            <Chip key={c} plain>
              {c}
            </Chip>
          ))}
        </dd>

        <dt className="text-[var(--color-muted)]">{t.models.lastProbe}</dt>
        <dd className="min-w-0">
          {model.verifiedAt ? (
            <span className="block text-[var(--color-ok)]">{fmt(t.models.verified, { when: relativeTime(model.verifiedAt) })}</span>
          ) : (
            <span className="block text-[var(--color-warn)]">{t.models.notVerified}</span>
          )}
          {probesRead && (
            <span className="tnum block text-xs text-[var(--color-muted)]">
              {probe
                ? probe.ok
                  ? fmt(t.models.probeOk, { when: relativeTime(probe.at) })
                  : fmt(t.models.probeFailed, { when: relativeTime(probe.at), code: probe.errorCode ?? "—" })
                : t.models.noProbe}
            </span>
          )}
        </dd>

        <dt className="text-[var(--color-muted)]">{t.models.price}</dt>
        <dd className="min-w-0">
          {model.creditUnit ? (
            prices === null ? (
              <span className="text-[var(--color-warn)]">{t.models.pricesFailed}</span>
            ) : price !== undefined && price > 0 ? (
              <span className="tnum text-[var(--color-fg)]">
                {fmt(t.models.priceRow, { credits: formatCredits(price, locale), unit: model.creditUnit })}
              </span>
            ) : (
              <span className="text-[var(--color-warn)]">{fmt(t.models.unpriced, { unit: model.creditUnit })}</span>
            )
          ) : (
            <span className="text-[var(--color-muted)]">—</span>
          )}
          {model.creditUnit && (
            <Link href={`${path("/credits")}#credit-prices`} className="mt-0.5 block text-xs text-[var(--color-primary)] underline-offset-2 hover:underline">
              {t.models.editPrice} →
            </Link>
          )}
        </dd>

        {model.entitlement && (
          <>
            <dt className="text-[var(--color-muted)]">{t.models.entitlement}</dt>
            <dd className="tnum min-w-0 truncate text-[var(--color-fg)]">{model.entitlement}</dd>
          </>
        )}
      </dl>

      {warnings.length > 0 && (
        <div id={`${warnId}-warn`} className="flex flex-col gap-1 rounded-[var(--ns-r-key)] border border-[var(--color-warn)] p-2.5" role="note">
          {warnings.map((w) => (
            <p key={w} className="flex items-start gap-1.5 text-xs leading-snug text-[var(--color-warn)]">
              <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{w}</span>
            </p>
          ))}
        </div>
      )}

      <fieldset className="flex flex-col gap-1.5" disabled={busy}>
        <legend className="mb-1.5 text-xs font-semibold text-[var(--color-muted)]">
          {busy ? t.models.saving : t.models.availability}
        </legend>
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
        <p className="text-xs text-[var(--color-fail)]" aria-live="polite">
          {error}
        </p>
      )}
    </article>
  );
}
