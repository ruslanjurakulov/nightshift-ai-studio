"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { relativeTime } from "@/lib/format";
import { EmptyState } from "@/components/ui";
import { Section } from "@/components/g4/Section";
import {
  confidencePct,
  evidenceLines,
  splitLearnings,
  type LearningDecision,
  type LearningRow,
} from "@/lib/learnings";

/**
 * Proposed learnings awaiting a decision, and the approved ones currently fed
 * into prompts. The buttons POST to /api/learnings/decide (admin only); the
 * server re-checks the role and the transition, so hiding them for a
 * non-admin is presentation, not the guard.
 */
export function LearningsPanel({
  rows,
  canDecide,
  showChannel,
  migrationMissing,
}: {
  rows: LearningRow[];
  canDecide: boolean;
  showChannel: boolean;
  migrationMissing: boolean;
}) {
  const { t } = useI18n();
  const { pending, approved, rejected } = splitLearnings(rows);

  if (migrationMissing) {
    return (
      <div className="panel p-5 sm:p-6" role="status">
        <p className="text-sm text-[var(--color-warn)]">{t.learnings.migrationMissing}</p>
      </div>
    );
  }

  return (
    <div className="g4-stack">
      <Section
        desk={pending.length > 0}
        title={t.learnings.pendingTitle}
        right={<span className="g4-when">{pending.length}</span>}
      >
        <p className="g4-note">{t.learnings.pendingNote}</p>
        {!canDecide && pending.length > 0 && <p className="g4-note tnum mt-1">{t.learnings.adminOnly}</p>}
        {pending.length === 0 ? (
          <EmptyState>{t.learnings.noPending}</EmptyState>
        ) : (
          <ul className="mt-2 flex flex-col">
            {pending.map((r) => (
              <LearningItem key={r.id} row={r} showChannel={showChannel}
                actions={canDecide ? ["approve", "reject"] : []} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={t.learnings.approvedTitle}
        right={<span className="g4-when">{approved.length}</span>}
      >
        <p className="g4-note">{t.learnings.approvedNote}</p>
        {approved.length === 0 ? (
          <EmptyState>{t.learnings.noApproved}</EmptyState>
        ) : (
          <ul className="mt-2 flex flex-col">
            {approved.map((r) => (
              <LearningItem key={r.id} row={r} showChannel={showChannel}
                actions={canDecide ? ["reject"] : []} withdraw />
            ))}
          </ul>
        )}
        <p className="g4-note tnum mt-4">
          {fmt(t.learnings.rejectedCount, { n: rejected.length })} · {t.learnings.confidenceHow}
        </p>
      </Section>
    </div>
  );
}

function LearningItem({
  row,
  showChannel,
  actions,
  withdraw = false,
}: {
  row: LearningRow;
  showChannel: boolean;
  actions: LearningDecision[];
  withdraw?: boolean;
}) {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [state, setState] = useState<"idle" | "busy" | "fail">("idle");
  const [error, setError] = useState("");
  const pct = confidencePct(row.confidence);
  const kindLabel = (t.learnings.kinds as Record<string, string>)[row.kind] ?? row.kind;

  async function decide(decision: LearningDecision) {
    setState("busy");
    setError("");
    try {
      const res = await fetch("/api/learnings/decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: row.id, decision }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? String(res.status));
        setState("fail");
        return;
      }
      setState("idle");
      router.refresh();
    } catch {
      setError("network");
      setState("fail");
    }
  }

  return (
    <li className="flex flex-col gap-2 border-b border-[var(--ns-rule)] py-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 tnum g4-small g4-muted">
        <span className="text-[var(--color-primary)]">{kindLabel}</span>
        {showChannel && <span>· {row.channel_id}</span>}
        <span>· {t.learnings.confidence}: {pct === null ? t.learnings.confidenceUnknown : `${pct}%`}</span>
        <span>· {t.learnings.proposed} {relativeTime(row.created_at, locale)}</span>
        {row.decided_at && <span>· {t.learnings.decided} {relativeTime(row.decided_at, locale)}</span>}
      </div>
      <p className="m-0 text-base text-[var(--color-fg)]">{row.observation}</p>
      {evidenceLines(row.evidence).length > 0 && (
        <details className="tnum g4-small g4-muted">
          <summary className="tap-link cursor-pointer">{t.learnings.evidence}</summary>
          <ul className="mt-1 flex flex-col gap-0.5 pl-3">
            {evidenceLines(row.evidence).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </details>
      )}
      {actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {actions.includes("approve") && (
            <button type="button" onClick={() => decide("approve")} disabled={state === "busy"}
              className="btn-sky is-quiet pill px-4 text-sm disabled:opacity-40">
              {t.learnings.approve}
            </button>
          )}
          {actions.includes("reject") && (
            <button type="button" onClick={() => decide("reject")} disabled={state === "busy"}
              className="btn-quiet pill px-4 text-sm text-[var(--color-muted)] disabled:opacity-40">
              {withdraw ? t.learnings.withdraw : t.learnings.reject}
            </button>
          )}
          <span className="tnum text-sm" aria-live="polite">
            {state === "busy" && <span className="text-[var(--color-muted)]">{t.learnings.saving}</span>}
            {state === "fail" && (
              <span className="text-[var(--color-fail)]">{fmt(t.learnings.failed, { error })}</span>
            )}
          </span>
        </div>
      )}
    </li>
  );
}
