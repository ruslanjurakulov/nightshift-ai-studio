"use client";

import { postOperator } from "@/lib/operator-post";
import { operatorFailureText } from "@/lib/setup-errors";
import { useId, useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { TriangleAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt, type Dictionary } from "@/lib/i18n";
import { relativeTime } from "@/lib/format";
import { formatCredits } from "@/lib/credits";
import { useChannelPath } from "@/lib/channels-client";
import { useToast } from "@/components/feedback/ToastProvider";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
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
  type ModelTermsAcceptance,
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
  terms,
  platformOwner,
}: {
  models: AdminModel[];
  /** Newest probe per model; null when the probe log could not be read. */
  probes: Record<string, ProbeSummary> | null;
  /** credits_per_unit by unit; null when the price list could not be read. */
  prices: Record<string, number> | null;
  terms: Record<string, ModelTermsAcceptance> | "not_enabled" | "failed";
  platformOwner: boolean;
}) {
  const { t } = useI18n();
  const onSale = models.filter((m) => isOnSale(m.availability)).length;
  return (
    <div className="flex flex-col gap-4">
      <p className="g2-note tnum">{fmt(t.models.count, { n: models.length, sale: onSale })}</p>
      {probes === null && <p className="g2-warn">{t.models.probesFailed}</p>}
      {typeof terms === "string" && <p className="g2-warn">{t.models.terms.errors[terms]}</p>}
      <section className="ns-desk g2-desk g2-wizard" aria-label={t.models.title}>
        <div className="g2-models">
          {models.map((m) => (
            <ModelCard
              key={m.id}
              model={m}
              probe={probes?.[m.id] ?? null}
              probesRead={probes !== null}
              prices={prices}
              acceptance={typeof terms !== "string" && Object.hasOwn(terms, m.id) ? terms[m.id] : null}
              canManageTerms={platformOwner && typeof terms !== "string"}
            />
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
  acceptance,
  canManageTerms,
}: {
  model: AdminModel;
  probe: ProbeSummary | null;
  probesRead: boolean;
  prices: Record<string, number> | null;
  acceptance: ModelTermsAcceptance | null;
  canManageTerms: boolean;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const path = useChannelPath();
  const warnId = useId();
  const [availability, setOptimisticAvailability] = useOptimistic(model.availability);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();
  const refresh = () => startRefresh(() => router.refresh());

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
    if (busy || refreshing || to === availability) return;
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
    toast.success(fmt(t.models.saved, { model: model.displayName, availability: label(to) }), { title: model.displayName });
    startRefresh(() => {
      setOptimisticAvailability(to);
      router.refresh();
    });
  }

  const price = model.creditUnit && prices ? prices[model.creditUnit] : undefined;
  const warnings: string[] = [];
  if (!model.verifiedAt) warnings.push(t.models.unverifiedWarning);
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

        {(model.termsGate || acceptance) && (
          <ModelTerms
            model={model}
            acceptance={acceptance}
            canManage={canManageTerms}
            disabled={busy || refreshing}
            refresh={refresh}
          />
        )}

        <fieldset className="flex flex-col gap-2" disabled={busy || refreshing}>
          <legend className="g2-label mb-2">{busy || refreshing ? t.models.saving : t.models.availability}</legend>
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

function requirementCopy(gate: string, copy: Dictionary["models"]["terms"]["requirements"]) {
  if (gate === "terms_review_required") return copy.review;
  if (gate === "written_consent_required") return copy.consent;

  const planToken = /^plan_required:(.+)$/.exec(gate)?.[1];
  const words = (planToken ?? gate).replace(/[_:-]+/g, " ").trim();
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  const templates = planToken ? copy.plan : copy.other;
  const vars: Record<string, string> = planToken ? { plan: label } : { requirement: label };
  return {
    label: fmt(templates.label, vars),
    accept: fmt(templates.accept, vars),
    confirmMessage: fmt(templates.confirmMessage, vars),
  };
}

function ModelTerms({
  model,
  acceptance,
  canManage,
  disabled,
  refresh,
}: {
  model: AdminModel;
  acceptance: ModelTermsAcceptance | null;
  canManage: boolean;
  disabled: boolean;
  refresh: () => void;
}) {
  const { t, locale } = useI18n();
  const { confirm, dialog } = useConfirm();
  const c = t.models.terms;
  const gate = model.termsGate;
  const requirement = gate ? requirementCopy(gate, c.requirements) : null;
  const blockedProvider = model.provider === "bytedance";

  async function change(revoke: boolean) {
    if (disabled || !canManage || (revoke ? !acceptance : !requirement || blockedProvider)) return;
    const action = revoke ? null : requirement;
    const revokeMessage = gate ? c.revokePreviousMessage : c.revokeMessage;
    const ok = await confirm({
      title: fmt(revoke ? c.revokeTitle : c.confirmTitle, { model: model.displayName }),
      message: action?.confirmMessage ?? revokeMessage,
      confirmLabel: action?.accept ?? c.revoke,
      tone: revoke ? "danger" : "primary",
      ...(revoke ? {} : { typeToConfirm: model.id, exactConfirmation: true }),
      run: async (typed) => {
        const out = await postOperator("/api/models/terms", revoke ? { id: model.id, revoke: true } : { id: model.id, gate, confirm: typed });
        if (out.ok) return true;
        const code = out.data.error;
        if (code === "gate_changed" || code === "not_accepted") refresh();
        if (typeof code === "string" && Object.hasOwn(c.errors, code)) return c.errors[code as keyof typeof c.errors];
        return operatorFailureText(t, out, c.errors.write_failed);
      },
      successMessage: revoke ? c.revoked : c.saved,
    });
    if (ok) refresh();
  }

  return (
    <div className="flex flex-col items-start gap-2">
      {requirement && <p className="g2-warn break-words">{fmt(t.models.termsGate, { gate: requirement.label })}</p>}
      {acceptance && (
        <p className={gate ? "g2-note" : "g2-ok"}>
          {fmt(gate ? c.previousAcceptance : acceptance.acceptedByYou ? c.acceptedByYou : c.accepted, {
            gate: requirementCopy(acceptance.gate, c.requirements).label,
            date: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(new Date(acceptance.acceptedAt)),
          })}
        </p>
      )}
      {model.termsUrl && <a href={model.termsUrl} target="_blank" rel="noopener noreferrer" className="tap-link g2-link text-sm">{c.link}</a>}
      {gate && blockedProvider && <p className="g2-note">{c.errors.bytedance}</p>}
      {canManage && requirement && !blockedProvider && (
        <button type="button" disabled={disabled} className="btn-quiet min-h-11 px-3 text-sm" onClick={() => void change(false)}>
          {requirement.accept}
        </button>
      )}
      {canManage && acceptance && (
        <button type="button" disabled={disabled} className="btn-quiet min-h-11 px-3 text-sm" onClick={() => void change(true)}>
          {c.revoke}
        </button>
      )}
      {dialog}
    </div>
  );
}
