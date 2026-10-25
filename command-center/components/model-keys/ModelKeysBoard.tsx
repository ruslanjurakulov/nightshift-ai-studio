"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { postOperator, type OperatorFailureKind, type OperatorResult } from "@/lib/operator-post";
import { maskedTail, type CardView, type KeyState, type UnreachableReason } from "@/lib/model-keys";
import type { ModelKeysDictionary } from "@/lib/i18n/model-keys/en";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";

const ENDPOINT = "/api/owner/model-keys";

const TONE: Record<KeyState, LampTone> = {
  not_set: "idle",
  checking: "run",
  verified: "ok",
  rejected: "fail",
  format_only: "warn",
  unreachable: "warn",
};

/** What the last attempt on a card came to. Only words and codes: the key is never part of it. */
type Attempt =
  | { kind: "rejected" }
  | { kind: "unreachable"; reason: UnreachableReason | null }
  | { kind: "saved"; state: "verified" | "format_only" }
  | { kind: "removed" }
  | { kind: "error"; code: string };

const REASONS: readonly UnreachableReason[] = ["timeout", "network", "rate_limited", "vendor_error", "redirect", "unexpected_response"];

const FAILURE_CODE: Record<OperatorFailureKind, string> = {
  session: "session",
  mfa: "mfa_required",
  mfa_enrol: "mfa_enrol_required",
  forbidden: "forbidden",
  rate_limited: "rate_limited",
  server: "server",
  not_recorded: "server",
  network: "network",
};

function errorCode(res: Extract<OperatorResult, { ok: false }>): string {
  const code = typeof res.data.error === "string" ? res.data.error : "";
  if (code === "bad_key" && typeof res.data.reason === "string") return `bad_key:${res.data.reason}`;
  if (code === "mfa_recent_required") return code;
  if (code && code !== "forbidden" && res.kind !== "mfa") return code;
  return FAILURE_CODE[res.kind];
}

function errorText(m: ModelKeysDictionary, code: string): string {
  if (code.startsWith("bad_key:")) {
    const reason = code.slice("bad_key:".length) as keyof ModelKeysDictionary["keyReason"];
    return m.keyReason[reason] ?? m.err.bad_key;
  }
  return (m.err as Record<string, string>)[code] ?? m.err.server;
}

/**
 * The owner's "Model API keys" page (NIGHTSHIFT_MODEL_KEYS on; migration 0123, docs/MODEL_API_KEYS.md).
 *
 * What it does and does not do:
 *  - One card per vendor. The key is typed into a password field, sent ONCE in the body of a POST to /api/owner/model-keys, and the field is
 *    emptied the moment it is sent. It is not kept in state after that, not put in a URL, a log line, a title or an error text, and the
 *    answer to the POST is a state word, never the key.
 *  - "API verified" is shown only for a key the vendor accepted. A vendor with no free check says so ("Format only") and asks for a tick
 *    before it saves; its key is never sent to the vendor from here.
 *  - A rejected or unreachable check saves nothing and leaves the stored key as it was.
 *  - A stored key is NOT what a run uses: runs read the environment. The "Key used by runs" line says which key is active.
 */
export function ModelKeysBoard({ cards }: { cards: CardView[] }) {
  const { t } = useI18n();
  const m = t.modelKeys;
  return (
    <div className="flex flex-col gap-4">
      <p className="g5-note">{m.vaultNote}</p>
      <ul className="m-0 flex list-none flex-col gap-4 p-0">
        {cards.map((card) => (
          <li key={card.id}>
            <KeyCard card={card} m={m} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function KeyCard({ card, m }: { card: CardView; m: ModelKeysDictionary }) {
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [key, setKey] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const formatOnly = card.mode === "format_only";
  const state: KeyState = busy
    ? "checking"
    : attempt?.kind === "rejected"
      ? "rejected"
      : attempt?.kind === "unreachable"
        ? "unreachable"
        : card.stored
          ? card.stored.status
          : "not_set";
  const idBase = `mk-${card.id}`;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !key.trim() || (formatOnly && !confirmed)) return;
    // The key leaves this component's state the moment it is sent; only the request body holds it.
    const body = { action: "save", provider: card.id, key, ...(formatOnly ? { confirm_format_only: true } : {}) };
    setKey("");
    setBusy(true);
    setAttempt(null);
    const res = await postOperator(ENDPOINT, body);
    if (!alive.current) return;
    setBusy(false);
    if (!res.ok) {
      setAttempt({ kind: "error", code: errorCode(res) });
      return;
    }
    const answer = typeof res.data.state === "string" ? res.data.state : "";
    if (answer === "verified" || answer === "format_only") {
      setConfirmed(false);
      setAttempt({ kind: "saved", state: answer });
      startRefresh(() => router.refresh());
    } else if (answer === "rejected") {
      setAttempt({ kind: "rejected" });
    } else if (answer === "unreachable") {
      const reason = REASONS.find((r) => r === res.data.reason) ?? null;
      setAttempt({ kind: "unreachable", reason });
    } else {
      setAttempt({ kind: "error", code: "server" });
    }
  }

  async function remove() {
    if (busy) return;
    setAsking(false);
    setBusy(true);
    setAttempt(null);
    const res = await postOperator(ENDPOINT, { action: "remove", provider: card.id });
    if (!alive.current) return;
    setBusy(false);
    if (!res.ok) {
      setAttempt({ kind: "error", code: errorCode(res) });
      return;
    }
    setAttempt({ kind: "removed" });
    startRefresh(() => router.refresh());
  }

  const sourceText =
    card.source === "env"
      ? [fmt(m.source.env, { names: card.envNames }), card.stored ? m.source.envAlsoVault : ""].filter(Boolean).join(" ")
      : card.source === "vault"
        ? m.source.vault
        : card.source === "none"
          ? m.source.none
          : m.source.unknown;

  return (
    <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-labelledby={`${idBase}-name`} data-provider={card.id} data-state={state}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id={`${idBase}-name`} className="t-section">
          {card.name}
        </h2>
        <StatusLamp tone={TONE[state]} label={m.status[state]} live={state === "checking"} />
      </div>

      {card.stored ? (
        <p className="g5-note" data-stored="">
          {m.card.storedKey}: <span className="tnum font-medium text-[var(--color-fg)]">{maskedTail(card.stored.last4)}</span>
          {card.stored.verifiedAt
            ? ` · ${fmt(card.stored.status === "verified" ? m.card.verifiedOn : m.card.formatOnlyOn, { date: card.stored.verifiedAt.slice(0, 10) })}`
            : ""}
        </p>
      ) : null}

      <p className="g5-note">{sourceText}</p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {card.keyUrl ? (
          <a className="g5-link" href={card.keyUrl} target="_blank" rel="noopener noreferrer" title={m.card.getKeyHint}>
            {m.card.getKey}
          </a>
        ) : (
          <span className="g5-note" data-link-unverified="">
            {m.card.linkUnverified}
          </span>
        )}
        {card.docUrl ? (
          <a className="g5-link" href={card.docUrl} target="_blank" rel="noopener noreferrer">
            {m.card.docs}
          </a>
        ) : null}
      </div>

      <p className="g5-note">
        {formatOnly ? m.card.howFormat : fmt(m.card.howHttp, { path: card.path ?? "", host: card.host ?? "" })}
      </p>
      {formatOnly ? (
        <p className="g5-note font-medium" data-format-only-note="">
          {m.card.formatOnlyNote}
        </p>
      ) : null}

      <form onSubmit={save} method="post" autoComplete="off" className="flex flex-col gap-3">
        <div className="g5-field">
          <label htmlFor={`${idBase}-key`} className="g5-k">
            {m.card.keyLabel}
          </label>
          {/* No `name`: the value can never be part of a native form submission, which would put it in a URL. */}
          <input
            id={`${idBase}-key`}
            type="password"
            className="ns-field min-h-11 min-w-0"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            disabled={busy}
            aria-describedby={card.pairedKey ? `${idBase}-hint` : undefined}
          />
          {card.pairedKey ? (
            <p id={`${idBase}-hint`} className="g5-note">
              {m.card.pairedHint}
            </p>
          ) : null}
        </div>
        {formatOnly ? (
          <label className="g5-check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} disabled={busy} />
            <span>{m.card.formatOnlyConfirm}</span>
          </label>
        ) : null}
        <div className="g5-actions">
          <button type="submit" className="btn-primary min-h-11 px-4 text-sm disabled:opacity-55" disabled={busy || !key.trim() || (formatOnly && !confirmed)}>
            {busy ? m.card.busy : formatOnly ? m.card.saveUnverified : m.card.verifyAndSave}
          </button>
          {card.stored && !asking ? (
            <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={() => setAsking(true)} disabled={busy}>
              {m.card.remove}
            </button>
          ) : null}
          {asking ? (
            <span className="flex flex-wrap items-center gap-2" role="group" aria-label={m.card.removeAsk}>
              <span className="text-sm">{m.card.removeAsk}</span>
              <button type="button" className="btn-danger min-h-11 px-4 text-sm" onClick={() => void remove()} disabled={busy}>
                {m.card.removeYes}
              </button>
              <button type="button" className="btn-quiet min-h-11 px-4 text-sm" onClick={() => setAsking(false)}>
                {m.card.cancel}
              </button>
            </span>
          ) : null}
        </div>
      </form>

      <div aria-live="polite" className="min-h-4">
        {attempt ? <AttemptNote attempt={attempt} card={card} m={m} /> : null}
      </div>
    </section>
  );
}

function AttemptNote({ attempt, card, m }: { attempt: Attempt; card: CardView; m: ModelKeysDictionary }) {
  const tone = attempt.kind === "saved" || attempt.kind === "removed" ? "var(--color-ok)" : "var(--color-fail)";
  const lines: string[] = [];
  if (attempt.kind === "saved") lines.push(m.result[attempt.state]);
  else if (attempt.kind === "removed") lines.push(m.result.removed);
  else if (attempt.kind === "rejected") {
    lines.push(m.result.rejected);
    if (card.scopedKeys) lines.push(m.result.rejectedScoped);
    if (card.regionBound) lines.push(m.result.rejectedRegion);
  } else if (attempt.kind === "unreachable") {
    lines.push(m.result.unreachable);
    if (attempt.reason) lines.push(m.unreachableReason[attempt.reason]);
  } else lines.push(errorText(m, attempt.code));
  return (
    <p className="break-words text-sm" style={{ color: tone }} data-attempt={attempt.kind} role={attempt.kind === "saved" || attempt.kind === "removed" ? "status" : "alert"}>
      {lines.join(" ")}
    </p>
  );
}
