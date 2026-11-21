"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Activity, ArrowUp, Mic, RotateCcw, Sparkles, TrendingUp, TriangleAlert, Users, Wallet, type LucideIcon } from "lucide-react";
import type { OwnerConsoleDictionary } from "@/lib/i18n/owner-console/en";

/**
 * The owner's Nightshift AI, drawn as a chat. It asks /api/brain/owner/turn and draws the answer; it holds no figure of its own (the
 * server builds the facts and the model answers from them). The conversation lives in this tab only: nothing is stored, and a reload
 * starts afresh. Nothing here acts: an answer is text, a draft is text to copy.
 */

type A = OwnerConsoleDictionary["assistant"];
interface Turn {
  q: string;
  a: string;
  draft: { title: string | null; body: string } | null;
  asOf: string | null;
  removedLinks: number;
}
/** retry: whether asking again can help (a daily cap, a missing key or migration will refuse again). */
type Failure = { message: string; verify?: boolean; clear?: boolean; signIn?: boolean; retry?: boolean };

export const QUESTION_MAX = 2000;
/** The counter appears only near the limit: a number under every keystroke is noise until it matters. */
export const COUNTER_FROM = 1800;
/** The box grows with the question up to about eight lines, then scrolls inside itself. */
const BOX_MAX_PX = 200;
/** One icon per suggestion, by position (money, people, health, revenue); a suggestion past the list gets the spark. */
const SUGGEST_ICONS: LucideIcon[] = [Wallet, Users, Activity, TrendingUp];

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? String(v[k]) : m));
const tashkent = (iso: string) => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms + 5 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
};
// The server render has no layout to measure; the browser measures before paint so the box never flashes at the wrong height.
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** The server's refusal, said with its remedy in the owner's language. Unknown codes get the generic line, never the raw code. */
export function failureText(a: A, status: number, body: Record<string, unknown> | null): Failure {
  const err = typeof body?.error === "string" ? body.error : "";
  const reason = typeof body?.reason === "string" ? body.reason : "";
  if (status === 401 && err === "second_factor") return { message: a.errors.second_factor, verify: true };
  if (status === 401 || status === 404) return { message: a.errors.session, signIn: true };
  if (err === "model_unavailable" && Object.hasOwn(a.errors.model_unavailable, reason))
    return { message: a.errors.model_unavailable[reason as keyof A["errors"]["model_unavailable"]] };
  if (err === "model_failed" && Object.hasOwn(a.errors.model_failed, reason))
    return { message: a.errors.model_failed[reason as keyof A["errors"]["model_failed"]], retry: !["vendor_auth", "vendor_quota", "not_configured"].includes(reason) };
  if (err === "daily_cap") return { message: fill(a.errors.daily_cap, { limit: typeof body?.limit === "number" ? body.limit : "—" }) };
  if (err === "not_enabled") return { message: fill(a.errors.not_enabled, { n: typeof body?.needs === "string" ? body.needs : "—" }) };
  if (err === "message_too_long") return { message: fill(a.tooLong, { n: QUESTION_MAX }) };
  if (status === 413 || err === "payload_too_large") return { message: a.errors.tooMuchHistory, clear: true };
  if (err === "unavailable") return { message: a.errors.unavailable, retry: true };
  return { message: a.errors.other, retry: true };
}

/** Enter sends; Shift+Enter is a new line; a key that ends an IME composition (Uzbek/Russian layouts on some phones) never sends. */
export function sendsOnKey(e: { key: string; shiftKey: boolean; isComposing?: boolean }): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.isComposing;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function OwnerAssistant({ a, verifyHref, signInHref }: { a: A; verifyHref: string; signInHref: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [lastAsked, setLastAsked] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const tail = useRef<HTMLDivElement>(null);
  // A ref, not state: two presses before the re-render must not both pass (each would be a paid turn).
  const inFlight = useRef(false);

  useEffect(() => {
    if (copied === null) return;
    const id = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  useIsoLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, BOX_MAX_PX)}px`;
  }, [question]);

  // The newest exchange (or the "thinking" bubble, or the error) is brought into view: with a sticky composer the owner would
  // otherwise ask, and the answer would land below the fold.
  useEffect(() => {
    if (turns.length === 0 && !pending && !failure) return;
    tail.current?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }, [turns.length, pending, failure]);

  function clearAll() {
    setTurns([]);
    setFailure(null);
    setLastAsked(null);
  }

  async function ask(text: string, fromBox = false) {
    const q = text.trim();
    if (!q || inFlight.current) return;
    if (q.length > QUESTION_MAX) {
      setLastAsked(null);
      setFailure({ message: fill(a.tooLong, { n: QUESTION_MAX }) });
      return;
    }
    inFlight.current = true;
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
          draft: d && typeof d.body === "string" ? { title: typeof d.title === "string" ? d.title : null, body: d.body } : null,
          asOf: typeof body.as_of === "string" ? body.as_of : null,
          removedLinks: typeof body.removed_links === "number" ? body.removed_links : 0,
        },
      ]);
      // A suggestion must not wipe what the owner had half-typed in the box.
      if (fromBox) setQuestion("");
      setLastAsked(null);
    } catch {
      setFailure({ message: a.errors.network, retry: true });
    } finally {
      inFlight.current = false;
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

  const empty = turns.length === 0 && !pending && !lastAsked;
  const canSend = !pending && question.trim() !== "";
  const near = question.length >= COUNTER_FROM;

  return (
    <div className="ai-chat">
      {turns.length > 0 && !failure?.clear && (
        <div className="ai-chat-bar">
          <button type="button" className="btn-quiet ai-new" disabled={pending} onClick={clearAll}>
            <RotateCcw aria-hidden size={14} />
            {a.newChat}
          </button>
        </div>
      )}

      <section className="ai-thread" aria-label={a.ai}>
        <div role="log" aria-live="polite" className="ai-log">
          {empty ? (
            <div className="ai-empty">
              <span className="ai-empty-mark" aria-hidden>
                <Sparkles size={20} />
              </span>
              <p className="ai-empty-tx">{a.empty}</p>
              <h2 className="oc-h2 ai-suggest-h">{a.suggestions}</h2>
              <ul role="list" className="ai-suggest">
                {a.suggest.map((s, i) => {
                  const Icon = SUGGEST_ICONS[i] ?? Sparkles;
                  return (
                    <li key={s}>
                      <button type="button" className="ai-suggest-card" disabled={pending} onClick={() => ask(s)}>
                        <span className="ai-suggest-ic" aria-hidden>
                          <Icon size={18} />
                        </span>
                        <span className="ai-suggest-tx">{s}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            turns.map((t, i) => (
              <article key={i} className="ai-turn">
                <div className="ai-msg ai-msg-you">
                  <p className="sr-only">{a.you}</p>
                  <p className="ai-bubble ai-bubble-you">{t.q}</p>
                </div>
                <div className="ai-msg ai-msg-ai">
                  <span className="ai-avatar" aria-hidden>
                    <Sparkles size={16} />
                  </span>
                  <div className="ai-bubble ai-bubble-ai">
                    <p className="ai-who">{a.ai}</p>
                    <p className="ai-answer">{t.a}</p>
                    {t.draft && (
                      <div className="oc-ai-draft">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="m-0 min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{t.draft.title ? `${a.draft}: ${t.draft.title}` : a.draft}</h3>
                          <button type="button" className="btn-quiet" onClick={() => copy(i, t.draft!.title ? `${t.draft!.title}\n\n${t.draft!.body}` : t.draft!.body)}>
                            {copied === i ? a.copied : a.copy}
                          </button>
                        </div>
                        <pre className="oc-ai-draft-body">{t.draft.body}</pre>
                      </div>
                    )}
                    {t.removedLinks > 0 && (
                      <p className="oc-note" data-tone="warn">
                        {a.linksRemoved}
                      </p>
                    )}
                    {t.asOf && tashkent(t.asOf) && <p className="oc-asof">{fill(a.asOf, { time: tashkent(t.asOf)! })}</p>}
                  </div>
                </div>
              </article>
            ))
          )}
        </div>

        {/* Outside the log: the question in flight (or the one that failed) and the "thinking" bubble are not answers, and a busy
            live region would hold the status back anyway. */}
        {lastAsked && (
          <div className="ai-turn" data-pending={pending || undefined}>
            <div className="ai-msg ai-msg-you">
              <p className="sr-only">{a.you}</p>
              <p className="ai-bubble ai-bubble-you">{lastAsked}</p>
            </div>
            {pending && (
              <div className="ai-msg ai-msg-ai">
                <span className="ai-avatar" aria-hidden>
                  <Sparkles size={16} />
                </span>
                <div className="ai-bubble ai-bubble-ai ai-typing" aria-hidden>
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            )}
          </div>
        )}
        <p className="sr-only" role="status">
          {pending ? a.asking : ""}
        </p>
        {copyFailed && (
          <p className="oc-note" role="status">
            {a.copyFailed}
          </p>
        )}
        {failure && (
          <div className="oc-ai-error ai-error" role="alert">
            <p className="m-0 flex items-start gap-2">
              <TriangleAlert aria-hidden size={16} className="ai-error-ic" />
              <span>{failure.message}</span>
            </p>
            <div className="oc-actions">
              {failure.verify ? (
                <a className="btn-quiet" href={verifyHref}>
                  {a.verify}
                </a>
              ) : failure.signIn ? (
                <a className="btn-quiet" href={signInHref}>
                  {a.signIn}
                </a>
              ) : failure.clear ? (
                <button type="button" className="btn-quiet" onClick={clearAll}>
                  {a.clear}
                </button>
              ) : (
                failure.retry &&
                lastAsked && (
                  <button type="button" className="btn-quiet" disabled={pending} onClick={() => ask(lastAsked)}>
                    {a.retry}
                  </button>
                )
              )}
            </div>
          </div>
        )}
        <div ref={tail} aria-hidden />
      </section>

      <form
        className="ai-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question, true);
        }}
      >
        <label htmlFor="owner-ai-q" className="sr-only">
          {a.label}
        </label>
        <div className="ai-composer-box">
          <textarea
            id="owner-ai-q"
            ref={box}
            className="ai-input"
            rows={1}
            maxLength={QUESTION_MAX}
            value={question}
            placeholder={a.placeholder}
            aria-describedby="owner-ai-keys owner-ai-count"
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (sendsOnKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) {
                e.preventDefault();
                void ask(question, true);
              }
            }}
          />
          <div className="ai-composer-row">
            {/* Voice is not built: the button says so (focusable, with its reason in the name), and does nothing. */}
            <button
              type="button"
              className="ai-icon-btn"
              aria-disabled="true"
              aria-label={`${a.mic} (${a.soon})`}
              data-tip={a.soon}
              onClick={(e) => e.preventDefault()}
            >
              <Mic aria-hidden size={18} />
            </button>
            <span id="owner-ai-count" className="ai-counter" data-full={question.length >= QUESTION_MAX || undefined}>
              {near ? fill(a.counter, { n: question.length, max: QUESTION_MAX }) : ""}
            </span>
            <button type="submit" className="ai-send" aria-label={pending ? a.asking : a.ask} disabled={!canSend}>
              <ArrowUp aria-hidden size={18} strokeWidth={2.5} />
            </button>
          </div>
        </div>
        <p className="ai-disclaimer">
          {a.noActions} <span id="owner-ai-keys" className="ai-keys">{a.keys}</span>
        </p>
      </form>
    </div>
  );
}
