"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pencil, Play, Plus, Trash2, Waypoints } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { formatCredits } from "@/lib/credits";
import type { StudioModel } from "@/lib/creative/studio";
import type { Workflow } from "@/lib/workflows";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";
import { WorkflowBuilder } from "./WorkflowBuilder";
import { removeWorkflow } from "./workflowsApi";
import { workflowErrorMessage } from "@/lib/workflows";

const RUN_TONE: Record<string, LampTone> = { running: "run", completed: "ok", failed: "fail", cancelled: "idle" };

export interface RunRow {
  id: string;
  workflow_name: string;
  status: string;
  /** null = not on record: said in words, never shown as 0. */
  max_credits: number | null;
  charged_credits: number | null;
  created_at: string | null;
}

/**
 * The organization's saved workflows, a place to make or change one, and its
 * recent runs. Saving and removing cost nothing and run nothing; a run starts
 * only from a workflow's own page, after its total is shown and confirmed.
 */
export function WorkflowsHome({
  orgId,
  models,
  workflows,
  runs,
  canEdit,
}: {
  orgId: string;
  models: StudioModel[];
  workflows: readonly Workflow[];
  runs: readonly RunRow[];
  canEdit: boolean;
}) {
  const { t, locale } = useI18n();
  const w = t.workflows;
  const path = useChannelPath();
  const router = useRouter();
  const id = useId();
  const [editing, setEditing] = useState<Workflow | "new" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const when = (iso: string | null) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  };

  async function onRemove(wf: Workflow) {
    setBusy(wf.id);
    setError(null);
    const out = await removeWorkflow(wf.id);
    setBusy(null);
    setConfirmRemove(null);
    if (!out.ok) {
      setError(workflowErrorMessage(t, out.error));
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-8">
      <div className="flex max-w-[62ch] flex-col gap-2">
        <p className="m-0 text-base text-[var(--color-muted)]">
          {w.moneyNote} {w.publishNote}
        </p>
        {!canEdit ? <p className="m-0 text-base text-[var(--color-muted)]">{w.readOnly}</p> : null}
      </div>

      {editing ? (
        <WorkflowBuilder
          key={editing === "new" ? "new" : editing.id}
          orgId={orgId}
          models={models}
          initial={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      ) : canEdit ? (
        <div>
          <button type="button" onClick={() => setEditing("new")} className="btn-sky is-solid pill inline-flex items-center gap-2 px-5 py-2.5 text-sm">
            <Plus className="size-4" aria-hidden />
            {w.newWorkflow}
          </button>
        </div>
      ) : null}

      <section aria-labelledby={`${id}-list`} className={`g3-section${editing ? "" : " ns-desk"}`}>
        <header className="g3-head">
          <h2 id={`${id}-list`} className="t-panel">
            {w.listTitle}
          </h2>
        </header>
        {error ? (
          <p role="alert" className="m-0 text-base text-[var(--color-fail)]">
            {error}
          </p>
        ) : null}
        {workflows.length === 0 ? (
          <div className="g3-empty">
            <Waypoints className="size-6 text-[var(--color-muted)]" aria-hidden strokeWidth={1.5} />
            <p className="m-0 max-w-[48ch] text-base text-[var(--color-muted)]">{w.empty}</p>
          </div>
        ) : (
          <ul className="g3-flows">
            {workflows.map((wf, n) => (
              <li key={wf.id} className="g3-flow">
                <div className="g3-flow-head">
                  <span className="g3-edge-no" aria-hidden>
                    {String(n + 1).padStart(2, "0")}
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-lg font-medium text-[var(--color-fg)]">{wf.name}</span>
                    <span className="text-sm text-[var(--color-muted)]">
                      {fmt(w.stepsCount, { n: wf.steps.length })} · {fmt(w.updated, { when: when(wf.updated_at) })}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link href={path(`/workflows/${wf.id}`)} className="btn-sky pill inline-flex items-center gap-2 px-4 py-2 text-sm">
                      <Play className="size-4" aria-hidden />
                      {w.open}
                    </Link>
                    {canEdit ? (
                      <>
                        <button type="button" onClick={() => setEditing(wf)} className="btn-sky ghost pill inline-flex items-center gap-2 px-4 py-2 text-sm">
                          <Pencil className="size-4" aria-hidden />
                          {w.edit}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmRemove(confirmRemove === wf.id ? null : wf.id)}
                          className="btn-sky is-quiet pill inline-flex items-center gap-2 px-4 py-2 text-sm"
                        >
                          <Trash2 className="size-4" aria-hidden />
                          {w.remove}
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>
                <ol className="g3-track">
                  {wf.steps.map((s, i) => (
                    <li key={i}>
                      <span className="g3-edge-no" aria-hidden>
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span className="sr-only">{i + 1}. </span>
                      {w.tools[s.capability] ?? s.capability}
                    </li>
                  ))}
                </ol>
                {confirmRemove === wf.id ? (
                  <div role="alertdialog" className="g3-confirm">
                    <span className="text-base">{fmt(w.removeConfirm, { name: wf.name })}</span>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => void onRemove(wf)} disabled={busy === wf.id} className="btn-sky g3-danger pill px-4 py-2 text-sm">
                        {busy === wf.id ? w.removing : w.remove}
                      </button>
                      <button type="button" onClick={() => setConfirmRemove(null)} className="btn-sky is-quiet pill px-4 py-2 text-sm">
                        {w.builder.cancel}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label={w.recentRuns} className="g3-section">
        <header className="g3-head">
          <h2 className="t-panel">{w.recentRuns}</h2>
        </header>
        {runs.length === 0 ? (
          <p className="m-0 text-base text-[var(--color-muted)]">{w.noRuns}</p>
        ) : (
          <ul className="g3-projects">
            {runs.map((r) => (
              <li key={r.id}>
                <Link href={path(`/workflows/runs/${r.id}`)} className="g3-run">
                  <StatusLamp tone={RUN_TONE[r.status] ?? "idle"} label={(w.status as Record<string, string>)[r.status] ?? r.status} live={r.status === "running"} hideLabel />
                  <span className="truncate text-base font-medium">{r.workflow_name}</span>
                  <span className="text-sm tabular-nums text-[var(--color-muted)]">
                    {r.charged_credits !== null && r.max_credits !== null
                      ? fmt(w.runSummary, {
                          status: (w.status as Record<string, string>)[r.status] ?? r.status,
                          charged: formatCredits(r.charged_credits, locale),
                          max: formatCredits(r.max_credits, locale),
                        })
                      : fmt(w.runSummaryUnknown, { status: (w.status as Record<string, string>)[r.status] ?? r.status })}{" "}
                    · {when(r.created_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
