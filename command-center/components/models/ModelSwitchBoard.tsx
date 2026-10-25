"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { ownerStamp } from "@/lib/format";
import { postOperator } from "@/lib/operator-post";
import {
  SWITCH_NOTE_MAX,
  SWITCH_REASONS,
  coerceCounts,
  type SwitchDoc,
  type SwitchInfo,
  type SwitchLogRow,
  type SwitchProvider,
  type SwitchReason,
  type SwitchScope,
} from "@/lib/model-switch";
import { providerLabel, reasonText, switchFailureText } from "@/lib/model-switch-text";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
import { StatusLamp } from "@/components/ui/StatusLamp";
import { StateBlock } from "@/components/states/StateBlock";

const ENDPOINT = "/api/owner/model-switch";
/** Each switch-off call stops at most 200 jobs (migration 0124); this many calls cover a queue of 100 000 and end a loop that cannot finish. */
const MAX_SWEEP_CALLS = 500;

/**
 * The owner's model switches (migration 0124, docs/MODEL_SWITCH.md): per provider and per model, ON or OFF, with the reason, who changed it
 * last and when, a confirmation that counts the jobs a switch-off touches, the optional alert, and the last changes.
 *
 * What it does NOT do: it decides nothing. Whether a model is hidden comes from the database's own `hidden`; every change is ONE call to
 * /api/owner/model-switch -> owner_set_model_switch as the signed-in owner, which stops the jobs not yet sent, releases their credits and
 * writes the audit in one transaction. There is no "switch all", no timer and no automatic switch-off: the alert only says so.
 * The page never shows a person's reason to anybody but the owner: users are told "temporarily unavailable".
 */
export function ModelSwitchBoard({ doc }: { doc: SwitchDoc }) {
  const { t, locale } = useI18n();
  const s = t.modelSwitch;
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { confirm, dialog } = useConfirm();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const busy = useRef(false);

  const refresh = () => startTransition(() => router.refresh());
  const when = (iso: string | null) => ownerStamp(iso, locale);
  const labelOf = (provider: string) => {
    const p = doc.providers.find((x) => x.provider === provider);
    return p ? providerLabel(p) : provider;
  };

  /** Switch ON: one confirmation, then the call. */
  async function switchOn(scope: SwitchScope, target: string, name: string, providerOff: boolean) {
    if (busy.current) return;
    busy.current = true;
    setMsg(null);
    const ok = await confirm({
      title: fmt(s.confirmOn.title, { name }),
      message: s.confirmOn.body,
      confirmLabel: s.confirmOn.confirm,
      tone: "primary",
      successMessage: providerOff ? s.done.onStillHidden : s.done.on,
      run: async () => {
        const out = await postOperator(ENDPOINT, { action: "set", scope, target, enabled: true });
        return out.ok ? true : switchFailureText(t, out, true);
      },
    });
    busy.current = false;
    refresh();
    if (ok) setMsg({ ok: true, text: providerOff ? s.done.onStillHidden : s.done.on });
  }

  /** Switch OFF: count what it touches first (the database's number, not a guess), then ask, then call with the confirmation. */
  async function switchOff(scope: SwitchScope, target: string, name: string, reason: SwitchReason, note: string, models: number): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setMsg(null);
    const preview = await postOperator(ENDPOINT, { action: "preview", scope, target });
    const counts = preview.ok ? coerceCounts(preview.data) : null;
    if (!preview.ok || !counts) {
      busy.current = false;
      setMsg({ ok: false, text: preview.ok ? s.confirmOff.previewFailed : `${s.confirmOff.previewFailed} ${switchFailureText(t, preview)}` });
      return false;
    }
    let stopped = 0;
    let inFlight = counts.inFlight;
    let remaining = 0;
    const ok = await confirm({
      title: fmt(s.confirmOff.title, { name }),
      message: s.confirmOff.body,
      confirmLabel: s.confirmOff.confirm,
      tone: "danger",
      details: [
        { label: s.reasonLabel, value: reasonText(t, reason) },
        ...(note ? [{ label: s.noteLabel, value: note, multiline: true }] : []),
        ...(scope === "provider" ? [{ label: s.confirmOff.modelsAffected, value: String(models) }] : []),
        { label: s.confirmOff.waiting, value: String(counts.waiting) },
        { label: s.confirmOff.inFlight, value: String(counts.inFlight) },
      ],
      run: async () => {
        // One call stops a bounded batch of jobs (the database says how many are left): the same OFF is sent again until nothing is
        // left, a call stops none (workers hold the rest: the last gate stops those) or the safety cap is reached. The switch itself is
        // whole after the first call, so a failure on a later one leaves the model OFF and says so.
        for (let call = 0; call < MAX_SWEEP_CALLS; call++) {
          const out = await postOperator(ENDPOINT, { action: "set", scope, target, enabled: false, reason, ...(note ? { note } : {}), confirm: true });
          if (!out.ok) return call === 0 ? switchFailureText(t, out, true) : s.done.sweepInterrupted; // later: the switch is whole, so no "nothing was changed"
          const batch = typeof out.data.jobs_stopped === "number" ? out.data.jobs_stopped : 0;
          stopped += batch;
          inFlight = typeof out.data.in_flight === "number" ? out.data.in_flight : inFlight;
          remaining = typeof out.data.remaining === "number" ? out.data.remaining : 0;
          if (remaining <= 0 || batch <= 0) break;
        }
        return true;
      },
    });
    busy.current = false;
    refresh();
    if (ok) {
      const done = fmt(s.done.off, { stopped, inFlight });
      setMsg({ ok: true, text: remaining > 0 ? `${done} ${fmt(s.done.stillWaiting, { remaining })}` : done });
    }
    return ok;
  }

  async function dismiss(id: number) {
    if (busy.current) return;
    busy.current = true;
    setMsg(null);
    const out = await postOperator(ENDPOINT, { action: "dismiss", id });
    busy.current = false;
    if (out.ok) {
      setMsg({ ok: true, text: s.alerts.dismissed });
      refresh();
    } else {
      setMsg({ ok: false, text: switchFailureText(t, out, true) });
    }
  }

  const hiddenCount = (p: SwitchProvider) => p.models.filter((m) => m.hidden).length;

  return (
    <div className="flex flex-col gap-4" data-testid="model-switch-board">
      {dialog}
      <p className="m-0 max-w-[68ch] text-sm text-[var(--color-muted)]">{s.subtitle}</p>

      {doc.enforced ? (
        <p className="m-0 text-sm text-[var(--color-muted)]" data-testid="switch-in-force">
          <StatusLamp tone="ok" label={s.inForce} />
        </p>
      ) : (
        <StateBlock tone="warn" title={s.notInForce.title} role="status" data-testid="switch-not-in-force">
          {s.notInForce.body}
        </StateBlock>
      )}

      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs leading-relaxed text-[var(--color-muted)]">
        <li>{s.providerHint}</li>
        <li>{s.saleNote}</li>
        <li>{s.pipelineNote}</li>
      </ul>

      <p role="status" aria-live="polite" className="m-0 min-h-[1.25rem] text-sm" data-testid="switch-message">
        {msg ? <span className={msg.ok ? "text-[var(--color-ok)]" : "text-[var(--color-fail)]"}>{msg.text}</span> : null}
      </p>

      <section className="panel flex flex-col gap-2 p-4 sm:p-5" aria-labelledby="sw-alerts-title">
        <h2 id="sw-alerts-title" className="t-section">
          {s.alerts.title}
        </h2>
        <p className="m-0 text-xs text-[var(--color-muted)]">
          {doc.autoSuggest ? fmt(s.alerts.on, { failures: doc.suggestThreshold, minutes: doc.suggestWindowMinutes }) : s.alerts.off}
        </p>
        {doc.alerts.length === 0 ? (
          <p className="m-0 text-sm text-[var(--color-muted)]">{s.alerts.none}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {doc.alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[var(--color-border)] p-3" data-testid="switch-alert">
                <span className="min-w-0 flex-1 text-sm text-[var(--color-fg)]">
                  {fmt(s.alerts.line, { provider: labelOf(a.provider), failures: a.failures, minutes: a.windowMinutes })}{" "}
                  <span className="text-[var(--color-muted)]">{s.alerts.note}</span>
                </span>
                <button
                  type="button"
                  className="tap press rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--color-panel)] px-3 py-1.5 text-xs font-medium"
                  onClick={() => dismiss(a.id)}
                >
                  {s.alerts.dismiss}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {doc.providers.map((p) => (
        <ProviderCard
          key={p.provider}
          p={p}
          enforced={doc.enforced}
          when={when}
          hiddenCount={hiddenCount(p)}
          onOff={switchOff}
          onOn={switchOn}
        />
      ))}

      <section className="panel flex flex-col gap-2 p-4 sm:p-5" aria-labelledby="sw-log-title">
        <h2 id="sw-log-title" className="t-section">
          {s.log.title}
        </h2>
        {doc.log.length === 0 ? (
          <p className="m-0 text-sm text-[var(--color-muted)]">{s.log.empty}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2 p-0" data-testid="switch-log">
            {doc.log.map((l, i) => (
              <LogLine key={`${l.at}-${i}`} l={l} when={when} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function LogLine({ l, when }: { l: SwitchLogRow; when: (iso: string | null) => string }) {
  const { t } = useI18n();
  const s = t.modelSwitch.log;
  const scope = l.scope ? t.modelSwitch.scope[l.scope].toLowerCase() : "";
  const target = l.target ?? "";
  const what =
    l.kind === "settings"
      ? s.settings
      : l.kind === "alert_dismissed"
        ? fmt(s.dismissedLine, { target })
        : fmt(l.enabled ? s.on : s.offLine, { scope, target });
  return (
    <li className="flex flex-col gap-0.5 rounded-xl border border-[var(--color-border)] p-3 text-sm" data-testid="switch-log-row">
      <span className="text-[var(--color-fg)]">
        <span className="text-[var(--color-muted)]">{when(l.at)}</span> · {l.actor ?? s.system} · {what}
      </span>
      {l.kind === "switch" && l.enabled === false ? (
        <span className="text-xs text-[var(--color-muted)]">
          {s.why}: {reasonText(t, l.reason)}
          {l.note ? ` — ${l.note}` : ""} · {s.stopped}: {l.jobsStopped}
        </span>
      ) : null}
    </li>
  );
}

function ProviderCard({
  p,
  enforced,
  when,
  hiddenCount,
  onOff,
  onOn,
}: {
  p: SwitchProvider;
  enforced: boolean;
  when: (iso: string | null) => string;
  hiddenCount: number;
  onOff: (scope: SwitchScope, target: string, name: string, reason: SwitchReason, note: string, models: number) => Promise<boolean>;
  onOn: (scope: SwitchScope, target: string, name: string, providerOff: boolean) => Promise<void>;
}) {
  const { t } = useI18n();
  const s = t.modelSwitch;
  const titleId = useId();
  return (
    <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-labelledby={titleId} data-testid="switch-provider" data-provider={p.provider}>
      <SwitchRow
        headingId={titleId}
        heading
        scope="provider"
        id={p.provider}
        name={providerLabel(p)}
        info={p.switch}
        hidden={p.hidden}
        providerOff={false}
        enforced={enforced}
        when={when}
        models={p.models.length}
        onOff={onOff}
        onOn={onOn}
        extra={
          <span className="text-xs text-[var(--color-muted)]">
            {fmt(s.models, { n: p.models.length })} · {fmt(s.hiddenModels, { n: hiddenCount })}
          </span>
        }
      />
      <details className="rounded-xl border border-[var(--color-border)]">
        <summary className="tap cursor-pointer px-3 py-2 text-sm font-medium text-[var(--color-fg)]">{fmt(s.models, { n: p.models.length })}</summary>
        <ul className="m-0 flex list-none flex-col divide-y divide-[var(--color-border)] p-0">
          {p.models.map((m) => (
            <li key={m.id} className="p-3" data-testid="switch-model" data-model={m.id}>
              <SwitchRow
                scope="model"
                id={m.id}
                name={m.displayName}
                info={m.switch}
                hidden={m.hidden}
                providerOff={p.hidden}
                enforced={enforced}
                when={when}
                models={1}
                onOff={onOff}
                onOn={onOn}
                extra={
                  <span className="text-xs text-[var(--color-muted)]">
                    <code>{m.id}</code> · {m.capabilities.join(", ")} · {saleWord(s.sale, m.availability)}
                  </span>
                }
              />
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function saleWord(sale: Record<string, string>, availability: string): string {
  return Object.prototype.hasOwnProperty.call(sale, availability) ? sale[availability] : availability;
}

function SwitchRow({
  headingId,
  heading = false,
  scope,
  id,
  name,
  info,
  hidden,
  providerOff,
  enforced,
  when,
  models,
  onOff,
  onOn,
  extra,
}: {
  headingId?: string;
  heading?: boolean;
  scope: SwitchScope;
  id: string;
  name: string;
  info: SwitchInfo | null;
  hidden: boolean;
  /** For a model: its provider is off (so a model that is on stays hidden). */
  providerOff: boolean;
  enforced: boolean;
  when: (iso: string | null) => string;
  models: number;
  onOff: (scope: SwitchScope, target: string, name: string, reason: SwitchReason, note: string, models: number) => Promise<boolean>;
  onOn: (scope: SwitchScope, target: string, name: string, providerOff: boolean) => Promise<void>;
  extra?: React.ReactNode;
}) {
  const { t } = useI18n();
  const s = t.modelSwitch;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<SwitchReason | "">("");
  const [note, setNote] = useState("");
  const reasonId = useId();
  const noteId = useId();
  const own = info !== null && !info.enabled; // this row itself says OFF
  // Words, from the database's own `hidden`: a row recorded as off while the switches are not in force hides nothing, and says so.
  const status = hidden
    ? own || scope === "provider"
      ? s.status.hidden
      : s.status.hiddenByProvider
    : own || providerOff
      ? s.status.offNotInForce
      : s.status.on;
  const state = own ? s.stateOff : s.stateOn;
  const tooLong = Array.from(note.trim()).length > SWITCH_NOTE_MAX;
  const Heading = heading ? "h2" : "span";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <Heading id={headingId} className={heading ? "t-section m-0 [overflow-wrap:anywhere]" : "text-sm font-semibold text-[var(--color-fg)] [overflow-wrap:anywhere]"}>
            {name}
          </Heading>
          <StatusLamp tone={hidden ? "warn" : "ok"} label={status} />
          {extra}
        </div>
        {own ? (
          <button
            type="button"
            disabled={!enforced}
            aria-label={fmt(s.switchLabel, { name, state })}
            className="tap press min-h-11 shrink-0 rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] hover:border-[var(--color-primary)] disabled:opacity-60"
            onClick={() => onOn(scope, id, name, providerOff)}
          >
            {s.switchOn}
          </button>
        ) : (
          <button
            type="button"
            disabled={!enforced}
            aria-expanded={open}
            aria-label={fmt(s.switchLabel, { name, state })}
            className="tap press min-h-11 shrink-0 rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] hover:border-[var(--color-primary)] disabled:opacity-60"
            onClick={() => setOpen((o) => !o)}
          >
            {s.switchOff}
          </button>
        )}
      </div>

      <p className="m-0 text-xs text-[var(--color-muted)]">
        {info === null
          ? s.neverChanged
          : `${fmt(s.lastChanged, { who: info.changedBy ?? s.whoUnknown, when: when(info.changedAt) })}${
              own ? ` · ${s.reasonLabel}: ${reasonText(t, info.reason)}${info.note ? ` — ${info.note}` : ""}` : ""
            }`}
      </p>

      {open && !own ? (
        <form
          className="flex flex-col gap-3 rounded-xl border border-[var(--color-border)] p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (reason === "" || tooLong) return;
            const done = await onOff(scope, id, name, reason, note.trim(), models);
            if (done) {
              setOpen(false);
              setReason("");
              setNote("");
            }
          }}
          aria-label={fmt(s.form.title, { name })}
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={reasonId} className="text-xs font-medium text-[var(--color-muted)]">
              {s.reasonLabel}
            </label>
            <select
              id={reasonId}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value as SwitchReason | "")}
              className="min-h-11 rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--color-panel)] px-3 text-sm text-[var(--color-fg)]"
            >
              <option value="" disabled>
                —
              </option>
              {SWITCH_REASONS.map((r) => (
                <option key={r} value={r}>
                  {s.reasons[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={noteId} className="text-xs font-medium text-[var(--color-muted)]">
              {s.noteLabel}
            </label>
            <input
              id={noteId}
              type="text"
              value={note}
              maxLength={SWITCH_NOTE_MAX * 2}
              onChange={(e) => setNote(e.target.value.replace(/[\r\n\t]+/g, " "))}
              aria-describedby={`${noteId}-hint`}
              autoComplete="off"
              className="min-h-11 rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--color-panel)] px-3 text-sm text-[var(--color-fg)]"
            />
            <span id={`${noteId}-hint`} className={`text-xs ${tooLong ? "text-[var(--color-fail)]" : "text-[var(--color-muted)]"}`}>
              {fmt(s.noteHint, { max: SWITCH_NOTE_MAX })}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={reason === "" || tooLong}
              className="tap press min-h-11 rounded-[var(--ns-r-key)] border border-[var(--color-fail)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-fail)] disabled:opacity-60"
            >
              {s.form.review}
            </button>
            <button
              type="button"
              className="tap press min-h-11 rounded-[var(--ns-r-key)] border border-[var(--ns-rule-strong)] bg-[var(--color-panel)] px-4 py-2 text-sm font-medium text-[var(--color-fg)]"
              onClick={() => setOpen(false)}
            >
              {s.form.cancel}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
