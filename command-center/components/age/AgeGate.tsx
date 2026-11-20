"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { coerceAgeState, type AgeState } from "@/lib/age";

/**
 * Asked once, of an account with no 18+ record (0199): at /welcome and on the first visit to Create. The answer is the
 * person's own statement, written by the database for them only and never edited. "Under 18" blocks creating with an
 * honest sentence (the models exist; their makers allow them for adults only). An unknown state draws nothing: the page
 * never stops anyone on a failed read, and the database still refuses an adult-only model without a record.
 */
export function AgeGate({ state, from, onDone }: { state: AgeState; from: "welcome" | "create"; onDone?: (s: AgeState) => void }) {
  const { t } = useI18n();
  const a = t.age;
  const router = useRouter();
  const [now, setNow] = useState<AgeState>(state);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (now === "minor") return <MinorNotice />;
  if (now !== "none") return null;

  async function answer(adult: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/age", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adult, from }),
      });
      const body = (await res.json().catch(() => ({}))) as { state?: unknown; error?: unknown };
      if (!res.ok) {
        setError(body.error === "age_unavailable" ? a.unavailable : a.failed);
        return;
      }
      const next = coerceAgeState(body);
      setNow(next);
      onDone?.(next);
      // The model list's "for adults only" locks are drawn on the server: read the page again.
      router.refresh();
    } catch {
      setError(a.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section role="region" aria-labelledby="age-gate-title" className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4" data-testid="age-gate">
      <h2 id="age-gate-title" className="m-0 text-base font-semibold text-[var(--color-fg)]">
        {a.title}
      </h2>
      <p className="m-0 text-sm text-[var(--color-muted)]">{a.body}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => answer(true)} className="btn-primary min-h-11" data-testid="age-confirm">
          {busy ? a.saving : a.confirm}
        </button>
        <button type="button" disabled={busy} onClick={() => answer(false)} className="btn-quiet min-h-11" data-testid="age-under">
          {a.under}
        </button>
      </div>
      <p className="m-0 text-xs text-[var(--color-muted)]">{a.legal}</p>
      {error && (
        <p role="alert" className="m-0 text-sm text-[var(--color-warn)]">
          {error}
        </p>
      )}
    </section>
  );
}

export function MinorNotice() {
  const { t } = useI18n();
  return (
    <section role="status" className="flex flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-panel)] p-4" data-tone="minor" data-testid="age-minor">
      <h2 className="m-0 text-base font-semibold text-[var(--color-fg)]">{t.age.minorTitle}</h2>
      <p className="m-0 text-sm text-[var(--color-muted)]">{t.age.minorBody}</p>
    </section>
  );
}
