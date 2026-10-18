"use client";

import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { formatCredits } from "@/lib/credits";
import { ownerTime } from "@/lib/format";
import type { OwnerSecurity, SecurityEvent } from "@/lib/owner-reads";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { ErrorState } from "@/components/ReadError";

/**
 * The server-side owner safety state, read-only (NIGHTSHIFT_OWNER_RPC on; platform owner/admin only).
 *
 * It shows what the database enforces: whether the second-factor gate is on, the grant and price limits, which owners
 * and admins have how many verified authenticators, and the newest security events. It has NO control that changes
 * any of that, and in particular no button that switches the gate (enable_admin_mfa): turning it on is a separate,
 * deliberate step the owner takes in the database once every owner and admin has two authenticators.
 *
 * Unknown stays unknown: a document that could not be read says so instead of showing "off" or "0 authenticators".
 */
export function OwnerSecurityPanel({
  state,
  security,
  events,
  eventsState,
}: {
  state: "ok" | "failed" | "unsupported";
  security: OwnerSecurity | null;
  events: SecurityEvent[] | null;
  eventsState: "ok" | "failed" | "unsupported";
}) {
  const { t, locale } = useI18n();
  const s = t.ownerRpc.security;
  const credits = (n: number | null) => (n === null ? s.unknown : fmt(s.creditsValue, { n: formatCredits(n, locale) }));
  const roleLabel: Record<string, string> = {
    owner: t.members.roleOwner,
    admin: t.members.roleAdmin,
    editor: t.members.roleEditor,
    viewer: t.members.roleViewer,
  };
  const why = (code: string | null) => (s.why as Record<string, string>)[code ?? ""] ?? s.why.other;

  return (
    <section id="owner-safety" className="panel flex flex-col gap-5 p-5 sm:p-6" aria-labelledby="owner-safety-title">
      <div>
        <h2 id="owner-safety-title" className="t-section">
          {s.title}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted)]">{s.subtitle}</p>
      </div>

      {state === "unsupported" ? (
        <p className="text-sm text-[var(--color-muted)]">{s.unsupported}</p>
      ) : state === "failed" || !security ? (
        <ErrorState compact message={s.failed} />
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">{s.gateTitle}</h3>
            <StatusLamp tone={security.gateOn ? "ok" : "idle"} label={security.gateOn ? s.gateOn : s.gateOff} />
            <p className="text-xs leading-relaxed text-[var(--color-muted)]">{security.gateOn ? s.gateOnNote : s.gateOffNote}</p>
            <p className="text-xs leading-relaxed text-[var(--color-muted)]">
              {s.callerTitle}:{" "}
              {security.caller.passes === null
                ? s.unknown
                : security.caller.passes
                  ? `${s.callerPasses} (${why(security.caller.why)})`
                  : fmt(s.callerFails, { why: why(security.caller.why) })}
            </p>
            {security.wouldBlockAfterEnable === true && <p className="text-xs text-[var(--color-warn)]">{s.wouldBlock}</p>}
          </div>

          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">{s.limitsTitle}</h3>
            <dl className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] text-sm">
              {[
                [s.limitCall, credits(security.grantMaxPerCall)],
                [s.limitDay, credits(security.grantMax24h)],
                [s.limitRatio, security.priceMaxRatio === null ? s.unknown : fmt(s.ratioValue, { n: security.priceMaxRatio })],
                [s.limitWindow, security.reverseWindowDays === null ? s.unknown : fmt(s.daysValue, { n: security.reverseWindowDays })],
                [s.limitRecent, security.recentMfaMinutes === null ? s.unknown : fmt(s.minutesValue, { n: security.recentMfaMinutes })],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2">
                  <dt className="text-[var(--color-muted)]">{label}</dt>
                  <dd className="tnum text-right font-semibold text-[var(--color-fg)]">{value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="flex flex-col gap-1.5">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">{s.adminsTitle}</h3>
            <ul className="flex flex-col">
              {security.admins.map((a) => (
                <li key={a.email} className="flex items-start justify-between gap-3 border-t border-[var(--color-border)] py-2.5 first:border-t-0">
                  <div className="min-w-0">
                    <p className="break-words text-sm text-[var(--color-fg)]">{a.email}</p>
                    <p className="text-xs text-[var(--color-muted)]">
                      {roleLabel[a.role] ?? a.role}
                      {a.bound ? "" : ` · ${s.notSignedIn}`}
                    </p>
                  </div>
                  <p className="tnum shrink-0 text-right text-xs text-[var(--color-fg)]">
                    {a.verifiedFactors === null ? s.factorsUnknown : a.verifiedFactors === 0 ? s.noFactor : a.verifiedFactors === 1 ? s.factorsOne : fmt(s.factors, { n: a.verifiedFactors })}
                  </p>
                </li>
              ))}
            </ul>
            <p className="text-xs leading-relaxed text-[var(--color-muted)]">
              {security.canEnable === null ? s.readyUnknown : security.canEnable ? s.readyYes : s.readyNo}
            </p>
            <p className="text-xs leading-relaxed text-[var(--color-muted)]">{s.switchNote}</p>
          </div>
        </>
      )}

      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-semibold text-[var(--color-fg)]">{s.eventsTitle}</h3>
        {eventsState === "unsupported" ? null : eventsState === "failed" || events === null ? (
          <ErrorState compact message={s.eventsFailed} />
        ) : events.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">{s.eventsEmpty}</p>
        ) : (
          <ul className="flex flex-col">
            {events.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 border-t border-[var(--color-border)] py-2.5 first:border-t-0">
                <p className="text-sm text-[var(--color-fg)]">
                  {(s.kinds as Record<string, string>)[e.kind] ?? e.kind}
                  <span className="ml-2 text-xs text-[var(--color-muted)]">{s.severity[e.severity]}</span>
                </p>
                <p className="break-words text-xs text-[var(--color-muted)]">
                  {[ownerTime(e.at, locale), e.target, e.actorEmail ? fmt(s.by, { who: e.actorEmail }) : "", e.reason].filter(Boolean).join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
