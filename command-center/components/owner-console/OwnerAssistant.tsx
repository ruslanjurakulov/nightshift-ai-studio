"use client";

import { useRef, useState } from "react";
import type { OwnerConsoleDictionary } from "@/lib/i18n/owner-console/en";

/**
 * The owner's Nightshift AI. A form that asks /api/brain/owner/turn and draws the answer; it holds no figure of its own (the server
 * builds the facts and the model answers from them). The conversation lives in this tab only: nothing is stored, and a reload
 * starts afresh. Nothing here acts: an answer is text, a draft is text to copy.
 */

type A = OwnerConsoleDictionary["assistant"];
interface Turn {
  q: string;
  a: string;
  draft: { title: string; body: string } | null;
  asOf: string | null;
}
type Failure = { message: string; verify?: boolean };

const QUESTION_MAX = 2000;
const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
const tashkent = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms + 5 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
};

/** The server's refusal, said with its remedy in the owner's language. Unknown codes get the generic line, never the raw code. */
export function failureText(a: A, status: number, body: Record<string, unknown> | null): Failure {
  const err = typeof body?.error === "string" ? body.error : "";
  const reason = typeof body?.reason === "string" ? body.reason : "";
  if (status === 401 && err === "second_factor") return { message: a.errors.second_factor, verify: true };
  if (status === 401 || status === 404) return { message: a.errors.session };
  if (err === "model_unavailable" && Object.hasOwn(a.errors.model_unavailable, reason))
    return { message: a.errors.model_unavailable[reason as keyof A["errors"]["model_unavailable"]] };
  if (err === "model_failed" && Object.hasOwn(a.errors.model_failed, reason))
    return { message: a.errors.model_failed[reason as keyof A["errors"]["model_failed"]] };
  if (err === "daily_cap") return { message: fill(a.errors.daily_cap, { limit: typeof body?.limit === "number" ? body.limit : "—" }) };
  if (err === "not_enabled") return { message: fill(a.errors.not_enabled, { n: typeof body?.needs === "string" ? body.needs : "—" }) };
  if (err === "message_too_long") return { message: fill(a.tooLong, { n: QUESTION_MAX }) };
  if (err === "unavailable") return { message: a.errors.unavailable };
  return { message: a.errors.other };
}

export function OwnerAssistant({ a, verifyHref }: { a: A; verifyHref: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [lastAsked, setLastAsked] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || pending) return;
    if (q.length > QUESTION_MAX) {
      setFailure({ message: fill(a.tooLong, { n: QUESTION_MAX }) });
      return;
    }
    setPending(true);
    setFailure(null);
    setLastAsked(q);
    try {
      const res = await fetch("/api/brain/owner/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, history: turns.map((t) => ({ q: t.q, a: t.a })).slice(-6) }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || typeof body?.answer !== "string") {
        setFailure(failureText(a, res.status, body));
        return;
      }
      const d = body.draft as { title?: unknown; body?: unknown } | null;
      setTurns((prev) => [
        ...prev,
        {
          q,
          a: body.answer as string,
          draft: d && typeof d.title === "string" && typeof d.body === "string" ? { title: d.title, body: d.body } : null,
          asOf: typeof body.as_of === "string" ? body.as_of : null,
        },
      ]);
      setQuestion("");
      setLastAsked(null);
    } catch {
      setFailure({ message: a.errors.network });
    } finally {
      setPending(false);
      box.current?.focus();
    }
  }

  async function copy(i: number, text: string) {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(i);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <div className="oc-stack">
      <section className="oc-card">
        <p className="m-0">{a.intro}</p>
        <p className="oc-note">{a.noActions}</p>
      </section>

      <section className="oc-card" aria-label={a.ai}>
        <div role="log" aria-live="polite" aria-busy={pending} className="oc-stack">
          {turns.length === 0 ? (
            <div className="oc-stack">
              <p className="oc-note">{a.empty}</p>
              <p className="oc-note">{a.suggestions}:</p>
              <ul role="list" className="m-0 flex list-none flex-col gap-2 p-0">
                {a.suggest.map((s) => (
                  <li key={s}>
                    <button type="button" className="btn-quiet text-start" disabled={pending} onClick={() => ask(s)}>
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            turns.map((t, i) => (
              <article key={i} className="oc-ai-turn">
                <p className="oc-ai-who">{a.you}</p>
                <p className="oc-ai-q">{t.q}</p>
                <p className="oc-ai-who">{a.ai}</p>
                <p className="oc-ai-a">{t.a}</p>
                {t.draft && (
                  <div className="oc-ai-draft">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="m-0 text-sm font-semibold">
                        {a.draft}: {t.draft.title}
                      </h3>
                      <button type="button" className="btn-quiet" onClick={() => copy(i, `${t.draft!.title}\n\n${t.draft!.body}`)}>
                        {copied === i ? a.copied : a.copy}
                      </button>
                    </div>
                    <pre className="oc-ai-draft-body">{t.draft.body}</pre>
                  </div>
                )}
                {t.asOf && tashkent(t.asOf) && <p className="oc-asof">{fill(a.asOf, { time: tashkent(t.asOf)! })}</p>}
              </article>
            ))
          )}
          {pending && <p className="oc-note">{a.asking}</p>}
        </div>
        {copyFailed && (
          <p className="oc-note" role="status">
            {a.copyFailed}
          </p>
        )}
        {failure && (
          <div className="oc-ai-error" role="alert">
            <p className="m-0">{failure.message}</p>
            <div className="oc-actions">
              {failure.verify ? (
                <a className="btn-quiet" href={verifyHref}>
                  {a.verify}
                </a>
              ) : (
                lastAsked && (
                  <button type="button" className="btn-quiet" disabled={pending} onClick={() => ask(lastAsked)}>
                    {a.retry}
                  </button>
                )
              )}
            </div>
          </div>
        )}
      </section>

      <form
        className="oc-card"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <label htmlFor="owner-ai-q" className="text-sm font-semibold">
          {a.label}
        </label>
        <textarea
          id="owner-ai-q"
          ref={box}
          className="oc-ai-input"
          rows={3}
          maxLength={QUESTION_MAX}
          value={question}
          placeholder={a.placeholder}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void ask(question);
            }
          }}
        />
        <div className="oc-actions">
          <button type="submit" className="btn-primary" disabled={pending || question.trim() === ""} aria-disabled={pending || question.trim() === ""}>
            {pending ? a.asking : a.ask}
          </button>
          {turns.length > 0 && (
            <button
              type="button"
              className="btn-quiet"
              disabled={pending}
              onClick={() => {
                setTurns([]);
                setFailure(null);
              }}
            >
              {a.clear}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
