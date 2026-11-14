"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ShieldCheck, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { nextFocusIndex } from "@/lib/feedback";
import {
  RIGHTS_TERMS_HREF,
  acknowledgeProblem,
  nextGroup,
  wordsFor,
  type AcknowledgeProblem,
  type MissingAcknowledgement,
  type RightsSubjectKey,
} from "@/lib/rights-acknowledgement";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** What the Studio knows when it opens the dialog. */
export type RightsAckState =
  /** Asking the database which of this press's inputs are still to acknowledge. */
  | { phase: "checking" }
  /** The (kind, subject) pairs this person has not acknowledged yet, and which input each subject is (for its label). */
  | { phase: "ask"; missing: readonly MissingAcknowledgement[]; subjectKeys: Readonly<Record<string, RightsSubjectKey>> };

/** One POST to /api/creative/acknowledgements; injectable so the dialog's states can be tested without a server. */
export type PostAcknowledgement = (input: { kind: string; text_version: string; subject: string; locale: string }) => Promise<{ status: number; body: Record<string, unknown> }>;

export const postAcknowledgement: PostAcknowledgement = async (input) => {
  const res = await fetch("/api/creative/acknowledgements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
};

/**
 * The "I take responsibility" step (migration 0174, docs/RIGHTS_ACKNOWLEDGEMENT.md), in front of a model whose provider (or the
 * law) makes the person confirm their rights to an input. It shows the exact words of the version the database asks about, an
 * UNTICKED checkbox and a link to Terms §6.2; Confirm records the answer for each input (acknowledge_rights) and only then hands
 * back to the Studio, which starts the job. The database still decides: create_creative_job refuses a job without the record.
 *
 * Never pre-ticked: the box starts unticked for every kind and every set of inputs (the component is keyed per group, and the
 * Studio opens a fresh one per press). Never remembered across inputs: the database answers per input, and this asks about
 * exactly the ones it names. Re-asked when the words change: a version this page does not carry is not shown at all ("reload"),
 * so nobody acknowledges words they were not shown.
 *
 * A bottom sheet on a phone, a centred dialog from `sm` up (PlanUpsellDialog's shell). Escape and the scrim close it (nothing is
 * recorded or started), Tab stays inside, and focus returns to what opened it.
 */
export function RightsAcknowledgementDialog({
  state,
  onAcknowledged,
  onClose,
  post = postAcknowledgement,
}: {
  state: RightsAckState;
  /** Every pair the database named is recorded: the Studio starts the job now. */
  onAcknowledged: () => void;
  onClose: () => void;
  post?: PostAcknowledgement;
}) {
  const { t } = useI18n();
  const d = t.rightsAck;
  const titleId = useId();
  const descId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // What is still to acknowledge: the database's list, minus what this dialog has recorded.
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  const remaining = state.phase === "ask" ? state.missing.filter((m) => !done.has(`${m.kind}|${m.textVersion}|${m.subject}`)) : [];
  const group = nextGroup(remaining);
  // The portal exists only in a browser, and only after hydration: a server render and the first client render agree (both
  // nothing), so a page that renders the dialog open never mismatches.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      const el = opener.current;
      if (el && el.isConnected) el.focus();
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    const next = nextFocusIndex(items.indexOf(document.activeElement as HTMLElement), items.length, e.shiftKey);
    if (next < 0) return;
    e.preventDefault();
    items[next].focus();
  }

  if (!mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-end justify-center sm:items-center sm:p-4" onKeyDown={onKeyDown}>
      <div aria-hidden className="absolute inset-0 bg-[var(--studio-scrim)]" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        aria-busy={state.phase === "checking"}
        data-testid="rights-ack"
        data-phase={state.phase}
        className="relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-[var(--ns-r-sheet)] border border-[var(--color-border)] bg-[var(--color-panel)] shadow-[var(--shadow-elevated)] sm:max-h-[85vh] sm:max-w-[560px] sm:rounded-[var(--ns-r-sheet)]"
      >
        <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-4 sm:px-6 sm:pt-5">
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden
              className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-[color-mix(in_srgb,var(--color-primary)_14%,transparent)] text-[var(--color-primary)]"
            >
              <ShieldCheck className="size-4" strokeWidth={2} />
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h2 id={titleId} className="text-base font-semibold leading-snug text-[var(--color-fg)]">
                {d.title}
              </h2>
              <p id={descId} className="text-sm leading-relaxed text-[var(--color-muted)]">
                {d.intro}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={d.close}
            className="tap-icon grid size-9 shrink-0 place-items-center rounded-[var(--ns-r-key)] text-[var(--color-muted)] hover:bg-[var(--studio-field)] hover:text-[var(--color-fg)]"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-4 sm:px-6 sm:pb-5">
          {state.phase === "checking" && (
            <p role="status" className="g2-note" data-testid="rights-ack-checking">
              {d.checking}
            </p>
          )}
          {state.phase === "ask" && group && (
            <AskGroup
              // A fresh box (unticked, no problem) for every kind and every set of inputs.
              key={`${group.kind}|${group.textVersion}|${group.subjects.join(",")}`}
              group={group}
              subjectKeys={state.subjectKeys}
              post={post}
              onClose={onClose}
              onRecorded={() => {
                const next = new Set(done);
                for (const s of group.subjects) next.add(`${group.kind}|${group.textVersion}|${s}`);
                setDone(next);
                if (!nextGroup(remaining.filter((m) => !next.has(`${m.kind}|${m.textVersion}|${m.subject}`)))) onAcknowledged();
              }}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AskGroup({
  group,
  subjectKeys,
  post,
  onClose,
  onRecorded,
}: {
  group: { kind: string; textVersion: string | null; subjects: string[] };
  subjectKeys: Readonly<Record<string, RightsSubjectKey>>;
  post: PostAcknowledgement;
  onClose: () => void;
  onRecorded: () => void;
}) {
  const { t, fmt, locale } = useI18n();
  const d = t.rightsAck;
  const uid = useId();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<AcknowledgeProblem | "stale" | null>(null);
  // Subjects recorded by an earlier press of this same box (a retry after a partial failure does not record them twice).
  const recorded = useRef<Set<string>>(new Set());
  const words = wordsFor({ kind: group.kind, textVersion: group.textVersion, subject: group.subjects[0] ?? "" });
  const shownProblem = words.ok ? problem : "stale";
  // Only a failure that another press could fix leaves the button on; the others need a reload or another file.
  const final =
    shownProblem === "stale" || shownProblem === "version_changed" || shownProblem === "unavailable" || shownProblem === "forbidden" || shownProblem === "rate_limited";

  async function confirm() {
    if (!words.ok || !checked || busy || final) return;
    setBusy(true);
    setProblem(null);
    try {
      for (const subject of group.subjects) {
        if (recorded.current.has(subject)) continue;
        // The language the words are shown in now is the one the record keeps.
        const res = await post({ kind: words.kind, text_version: words.textVersion, subject, locale });
        if (res.status !== 200 && res.status !== 201) {
          setProblem(acknowledgeProblem(res.status, res.body.error));
          return;
        }
        recorded.current.add(subject);
      }
      onRecorded();
    } catch {
      setProblem("failed");
    } finally {
      setBusy(false);
    }
  }

  const kindWords = words.ok ? d.kinds[words.kind] : null;
  return (
    <form
      className="ns-panel"
      data-tone="sunken"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void confirm();
      }}
      data-testid="rights-ack-ask"
      data-kind={group.kind}
    >
      <div className="p-4 flex flex-col gap-4">
        {kindWords && (
          <>
            <p className="g2-strong" data-testid="rights-ack-question">
              {kindWords.question}
            </p>
            <div className="flex flex-col gap-1">
              <p className="g2-note">{d.subjectsLabel}</p>
              <ul className="flex flex-col gap-0.5 text-sm text-[var(--color-fg)]">
                {group.subjects.map((s) => (
                  <li key={s}>{d.subjects[subjectKeys[s] ?? "other"]}</li>
                ))}
              </ul>
            </div>
            <label className="flex items-start gap-2" htmlFor={`${uid}-take`}>
              <input
                id={`${uid}-take`}
                type="checkbox"
                className="mt-1 shrink-0"
                checked={checked}
                disabled={busy}
                onChange={(e) => {
                  setChecked(e.target.checked);
                  if (problem === "failed" || problem === "source_unavailable") setProblem(null);
                }}
                aria-describedby={`${uid}-statement`}
                data-testid="rights-ack-checkbox"
              />
              <span className="flex flex-col gap-1">
                <span className="g2-strong">{d.checkbox}</span>
                <span id={`${uid}-statement`} className="text-sm leading-relaxed text-[var(--color-fg)]" data-testid="rights-ack-statement">
                  {kindWords.statement}
                </span>
              </span>
            </label>
            <p className="g2-note">
              <a href={RIGHTS_TERMS_HREF} target="_blank" rel="noreferrer" className="underline underline-offset-2" data-testid="rights-ack-terms">
                {d.termsLink}
              </a>
            </p>
            <p className="g2-note">{d.recordNote}</p>
            {words.ok && <p className="g2-note tnum">{fmt(d.version, { version: words.textVersion })}</p>}
          </>
        )}
        <div role="status" aria-live="polite" className="empty:hidden">
          {shownProblem && (
            <p className="g2-fail" role="alert" data-testid="rights-ack-problem" data-problem={shownProblem}>
              {d.problems[shownProblem]}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!final && (
            <button type="submit" className="btn-primary" disabled={!words.ok || !checked || busy} data-testid="rights-ack-confirm">
              {busy ? d.confirming : problem ? d.retry : d.confirm}
            </button>
          )}
          <button type="button" className="btn-quiet" onClick={onClose} disabled={busy}>
            {d.cancel}
          </button>
        </div>
      </div>
    </form>
  );
}
