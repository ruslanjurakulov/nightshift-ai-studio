"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { postOperator, type OperatorFailureKind, type OperatorResult } from "@/lib/operator-post";
import type { CardView, CouldNotReachReason, KeyState } from "@/lib/model-keys";
import type { ModelKeysDictionary } from "@/lib/i18n/model-keys/en";
import { StatusLamp, type LampTone } from "@/components/ui/StatusLamp";

const ENDPOINT = "/api/owner/model-keys";

const TONE: Record<KeyState, LampTone> = {
  not_checked: "idle",
  checking: "run",
  verified: "ok",
  rejected: "fail",
  format_only: "warn",
  could_not_reach: "warn",
};

/** What the last check on a card came to. Words and a time only: the key is never part of it, and it is not kept past this visit. */
type Result =
  | { kind: "verdict"; state: "verified" | "rejected" | "format_only" | "could_not_reach"; at: string; reason: CouldNotReachReason | null }
  | { kind: "error"; code: string };

const REASONS: readonly CouldNotReachReason[] = ["timeout", "network", "rate_limited", "vendor_error", "redirect", "unexpected_response"];

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

/** `2026-10-25T09:30:12.000Z` -> `09:30 UTC`. The time the server gave the verdict. */
const clock = (iso: string) => `${iso.slice(11, 16)} UTC`;

/**
 * The owner's "Model API keys" page (NIGHTSHIFT_MODEL_KEYS on; docs/MODEL_API_KEYS.md): VERIFY AND FORGET.
 *
 *  - One card per vendor. The key is typed into a password field, sent ONCE in the body of a POST to /api/owner/model-keys, and the field is
 *    emptied the moment it is sent. It is not kept in state after that, not put in a URL, a log line, a title or an error text, and the
 *    answer to the POST is a state word and a time, never the key.
 *  - NOTHING IS STORED, here or on the server. The verdict lives in this component's state for this visit only; a reload shows
 *    "Not checked" again. There is no Remove and no masked tail because there is nothing to remove or mask. Nothing is written to
 *    localStorage, sessionStorage, a cookie or the URL.
 *  - "API verified" is shown only for a key the vendor accepted, and always with "the key was not saved". A vendor with no free check says
 *    "Format only": its key is never sent to the vendor from here.
 *  - Every card shows the exact name to set in GitHub Actions secrets and the worker environment, and which key a run uses today.
 */
export function ModelKeysBoard({ cards }: { cards: CardView[] }) {
  const { t } = useI18n();
  const m = t.modelKeys;
  return (
    <div className="flex flex-col gap-4">
      <p className="g5-note font-medium" data-nothing-stored="">
        {m.nothingStored}
      </p>
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
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const formatOnly = card.mode === "format_only";
  const state: KeyState = busy ? "checking" : result?.kind === "verdict" ? result.state : "not_checked";
  const idBase = `mk-${card.id}`;

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !key.trim()) return;
    // The key leaves this component's state the moment it is sent; only the request body holds it.
    const body = { action: "verify", provider: card.id, key };
    setKey("");
    setBusy(true);
    setResult(null);
    const res = await postOperator(ENDPOINT, body);
    if (!alive.current) return;
    setBusy(false);
    if (!res.ok) {
      setResult({ kind: "error", code: errorCode(res) });
      return;
    }
    const s = res.data.state;
    const at = typeof res.data.at === "string" ? res.data.at : "";
    if ((s === "verified" || s === "rejected" || s === "format_only" || s === "could_not_reach") && at) {
      const reason = REASONS.find((r) => r === res.data.reason) ?? null;
      setResult({ kind: "verdict", state: s, at, reason });
    } else {
      setResult({ kind: "error", code: "server" });
    }
  }

  const sourceText =
    card.source === "env"
      ? fmt(m.source.env, { names: card.envNames })
      : card.source === "none"
        ? fmt(m.source.none, { names: card.envNames })
        : m.source.unknown;

  return (
    <section className="panel flex flex-col gap-3 p-4 sm:p-5" aria-labelledby={`${idBase}-name`} data-provider={card.id} data-state={state}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id={`${idBase}-name`} className="t-section">
          {card.name}
        </h2>
        <StatusLamp tone={TONE[state]} label={m.status[state]} live={state === "checking"} />
      </div>

      <p className="g5-note" data-source={card.source}>
        <span className="font-medium">{m.source.label}:</span> {sourceText}
      </p>

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

      <p className="g5-note">{formatOnly ? m.card.howFormat : fmt(m.card.howHttp, { path: card.path ?? "", host: card.host ?? "" })}</p>
      {formatOnly ? (
        <p className="g5-note font-medium" data-format-only-note="">
          {m.card.formatOnlyNote}
        </p>
      ) : null}

      <form onSubmit={verify} method="post" autoComplete="off" className="flex flex-col gap-3">
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
        <div className="g5-actions">
          <button type="submit" className="btn-primary min-h-11 px-4 text-sm disabled:opacity-55" disabled={busy || !key.trim()}>
            {m.card.verify}
          </button>
        </div>
      </form>

      <div aria-live="polite" className="min-h-4">
        {result ? <ResultNote result={result} card={card} m={m} /> : null}
      </div>

      <p className="g5-note" data-use-it="">
        {fmt(m.card.useIt, { names: card.envNames })}
      </p>
    </section>
  );
}

function ResultNote({ result, card, m }: { result: Result; card: CardView; m: ModelKeysDictionary }) {
  const lines: string[] = [];
  let tone = "var(--color-fail)";
  if (result.kind === "error") lines.push(errorText(m, result.code));
  else {
    const time = clock(result.at);
    if (result.state === "verified") {
      tone = "var(--color-ok)";
      lines.push(fmt(m.verdict.verified, { time }));
    } else if (result.state === "format_only") {
      tone = "var(--color-warn)";
      lines.push(fmt(m.verdict.format_only, { time }));
    } else if (result.state === "rejected") {
      lines.push(fmt(m.verdict.rejected, { time }));
      if (card.scopedKeys) lines.push(m.verdict.rejectedScoped);
      if (card.regionBound) lines.push(m.verdict.rejectedRegion);
    } else {
      tone = "var(--color-warn)";
      lines.push(fmt(m.verdict.couldNotReach, { time }));
      if (result.reason) lines.push(m.reason[result.reason]);
    }
  }
  return (
    <p
      className="break-words text-sm"
      style={{ color: tone }}
      data-attempt={result.kind === "error" ? "error" : result.state}
      role={result.kind === "verdict" && result.state === "verified" ? "status" : "alert"}
    >
      {lines.join(" ")}
    </p>
  );
}
