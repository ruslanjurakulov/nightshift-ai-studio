"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import type { OwnerConsoleDictionary } from "@/lib/i18n/owner-console/en";
import { ChatShell, type ChatTurn } from "@/components/chat/ChatShell";
import { ChatHistoryFrame, type ChatHistorySource, type HistoryResult } from "@/components/chat/ChatHistory";

export { sendsOnKey } from "@/components/chat/ChatShell";

/**
 * The owner's Nightshift AI, drawn in the shared chat shell. It asks /api/brain/owner/turn and draws the answer; it holds no figure
 * of its own (the server builds the facts and the model answers from them). The server appends each answered turn to the owner's
 * stored history (0209) and hands back the session id, which this tab sends with the next question. With `history` on, the shared
 * history panel lists those sessions through /api/brain/owner/history (owner-only, the 0209 functions only), and opening one
 * continues it. Nothing here acts: an answer is text, a draft is text to copy.
 */

type A = OwnerConsoleDictionary["assistant"];
interface Turn {
  id: number;
  q: string;
  a: string;
  draft: { title: string | null; body: string } | null;
  asOf: string | null;
  removedLinks: number;
  /** Whether the server stored this turn (0209), as the route said it; absent for turns read back from the history (stored by
   *  definition). Shown, never assumed: an unsaved answer must not look like it will be there tomorrow (rule 5). */
  saved?: SaveState;
}
type SaveState = keyof A["saveState"];
const readSaveState = (v: unknown): SaveState => (v === "saved" || v === "needs_migration" ? v : "not_saved");
/** retry: whether asking again can help (a daily cap, a missing key or migration will refuse again). */
type Failure = { message: string; verify?: boolean; clear?: boolean; signIn?: boolean; retry?: boolean };

export const QUESTION_MAX = 2000;
/** The counter appears only near the limit: a number under every keystroke is noise until it matters. */
export const COUNTER_FROM = 1800;
const HISTORY = 6;

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
  if (status === 401 || status === 404) return { message: a.errors.session, signIn: true };
  if (err === "model_unavailable" && Object.hasOwn(a.errors.model_unavailable, reason))
    return { message: a.errors.model_unavailable[reason as keyof A["errors"]["model_unavailable"]] };
  if (err === "model_failed" && Object.hasOwn(a.errors.model_failed, reason))
    return { message: a.errors.model_failed[reason as keyof A["errors"]["model_failed"]], retry: !["vendor_auth", "vendor_quota", "not_configured", "vendor_region", "model_not_found"].includes(reason) };
  if (err === "daily_cap") return { message: fill(a.errors.daily_cap, { limit: typeof body?.limit === "number" ? body.limit : "—" }) };
  if (err === "not_enabled") return { message: fill(a.errors.not_enabled, { n: typeof body?.needs === "string" ? body.needs : "—" }) };
  if (err === "message_too_long") return { message: fill(a.tooLong, { n: QUESTION_MAX }) };
  if (status === 413 || err === "payload_too_large") return { message: a.errors.tooMuchHistory, clear: true };
  if (err === "unavailable") return { message: a.errors.unavailable, retry: true };
  return { message: a.errors.other, retry: true };
}

const HISTORY_ROUTE = "/api/brain/owner/history";
type Stored = { role: string; text: string; as_of: string | null };

/** A history call's refusal in the owner's language, with its remedy; "gone" is kept apart so the panel drops that row only. */
export function historyFailure(a: A, status: number, body: Record<string, unknown> | null): { ok: false; gone?: boolean; message: string } {
  const err = typeof body?.error === "string" ? body.error : "";
  if (err === "gone") return { ok: false, gone: true, message: a.history.gone };
  if (status === 401 && err === "second_factor") return { ok: false, message: a.errors.second_factor };
  if (status === 401 || status === 404) return { ok: false, message: a.errors.session };
  if (err === "not_enabled") return { ok: false, message: fill(a.errors.not_enabled, { n: typeof body?.needs === "string" ? body.needs : "—" }) };
  if (err === "invalid_title") return { ok: false, message: a.history.invalidTitle };
  return { ok: false, message: a.history.failed };
}

async function historyCall<T>(a: A, url: string, init: RequestInit | undefined, read: (b: Record<string, unknown>) => T): Promise<HistoryResult<T>> {
  try {
    const res = await fetch(url, init);
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !body) return historyFailure(a, res.status, body);
    return { ok: true, value: read(body) };
  } catch {
    return { ok: false, message: a.errors.network };
  }
}

/** Stored messages (owner, ai, owner, ai…) back into turns. A question whose answer was not saved keeps a line saying so, rather
 *  than vanishing or borrowing the next answer. */
export function turnsFromMessages(a: A, messages: Stored[]): Omit<Turn, "id">[] {
  const out: Omit<Turn, "id">[] = [];
  let q: string | null = null;
  const unanswered = (text: string) => out.push({ q: text, a: a.history.noAnswer, draft: null, asOf: null, removedLinks: 0 });
  for (const m of messages) {
    if (m.role === "owner") {
      if (q !== null) unanswered(q);
      q = m.text;
    } else if (q !== null) {
      out.push({ q, a: m.text, draft: null, asOf: m.as_of, removedLinks: 0 });
      q = null;
    }
  }
  if (q !== null) unanswered(q);
  return out;
}

export function OwnerAssistant({
  a,
  greeting,
  verifyHref,
  signInHref,
  history = false,
}: {
  a: A;
  greeting: string;
  verifyHref: string;
  signInHref: string;
  /** The stored-history panel: the owner page turns it on; off, the chat keeps only the session id of this tab. */
  history?: boolean;
  locale?: string;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** The question in flight or the one that failed; regen: it re-asks the last answered question, whose answer it will replace. */
  const [asking, setAsking] = useState<{ q: string; regen: boolean } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  // A ref, not state: two presses before the re-render must not both pass (each would be a paid turn).
  const inFlight = useRef(false);
  const nextId = useRef(1);
  // The stored conversation (0209) this tab is writing to: without it every question would start a new saved chat.
  const sessionId = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [opening, setOpening] = useState(false);

  function clearAll() {
    setTurns([]);
    setFailure(null);
    setAsking(null);
    sessionId.current = null;
    setActiveId(null);
  }

  const source = useMemo<ChatHistorySource>(
    () => ({
      list: (before) =>
        historyCall(a, before ? `${HISTORY_ROUTE}?before=${encodeURIComponent(before)}` : HISTORY_ROUTE, undefined, (b) => ({
          items: (Array.isArray(b.sessions) ? (b.sessions as { id: string; title: string; updated_at: string }[]) : []).map((r) => ({
            id: r.id,
            title: r.title,
            updatedAt: r.updated_at,
          })),
          nextBefore: typeof b.next_before === "string" ? b.next_before : null,
        })),
      rename: (id, title) =>
        historyCall(a, HISTORY_ROUTE, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ session: id, title }) }, () => null),
      remove: (id) => historyCall(a, `${HISTORY_ROUTE}?session=${encodeURIComponent(id)}`, { method: "DELETE" }, () => null),
    }),
    [a],
  );

  async function openSession(id: string): Promise<HistoryResult<null>> {
    if (inFlight.current) return { ok: true, value: null };
    setOpening(true);
    const r = await historyCall(a, `${HISTORY_ROUTE}?session=${encodeURIComponent(id)}`, undefined, (b) => (Array.isArray(b.messages) ? (b.messages as Stored[]) : []));
    setOpening(false);
    if (!r.ok) {
      // The chat on screen was deleted elsewhere: the next question must not try to append to it.
      if (r.gone && sessionId.current === id) clearAll();
      return r;
    }
    setTurns(turnsFromMessages(a, r.value).map((t) => ({ ...t, id: nextId.current++ })));
    setFailure(null);
    setAsking(null);
    sessionId.current = id;
    setActiveId(id);
    return { ok: true, value: null };
  }

  async function ask(text: string, regen = false): Promise<boolean> {
    const q = text.trim();
    if (!q || inFlight.current) return false;
    if (q.length > QUESTION_MAX) {
      setAsking(null);
      setFailure({ message: fill(a.tooLong, { n: QUESTION_MAX }) });
      return false;
    }
    inFlight.current = true;
    setPending(true);
    setFailure(null);
    setAsking({ q, regen });
    // A regenerate asks the last question again with the history before it: the answer being replaced is not context.
    const before = regen ? turns.slice(0, -1) : turns;
    try {
      const res = await fetch("/api/brain/owner/turn", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, history: before.map((t) => ({ q: t.q, a: t.a })).slice(-HISTORY), session_id: sessionId.current }),
      });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || typeof body?.answer !== "string") {
        setFailure(failureText(a, res.status, body));
        return false;
      }
      // null after a save that could not land (a chat deleted on another device): the next question starts a new stored chat.
      const sid = typeof body.session_id === "string" ? body.session_id : null;
      // A chat the server just created is shown in the panel straight away.
      if (sid && sid !== sessionId.current) setReloadKey((k) => k + 1);
      sessionId.current = sid;
      setActiveId(sid);
      const d = body.draft as { title?: unknown; body?: unknown } | null;
      const turn: Turn = {
        id: nextId.current++,
        q,
        a: body.answer as string,
        draft: d && typeof d.body === "string" ? { title: typeof d.title === "string" ? d.title : null, body: d.body } : null,
        asOf: typeof body.as_of === "string" ? body.as_of : null,
        removedLinks: typeof body.removed_links === "number" ? body.removed_links : 0,
        saved: readSaveState(body.history),
      };
      // The old answer is replaced only once the new one has arrived: a failed regenerate keeps it on screen.
      setTurns((prev) => (regen ? [...prev.slice(0, -1), turn] : [...prev, turn]));
      setAsking(null);
      return true;
    } catch {
      setFailure({ message: a.errors.network, retry: true });
      return false;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  async function copyDraft(id: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
    } catch {
      setFailure({ message: a.copyFailed });
    }
  }

  const shellTurns: ChatTurn[] = turns.map((t) => ({
    id: t.id,
    q: t.q,
    a: t.a,
    extra:
      t.draft || t.removedLinks > 0 || t.saved || (t.asOf && tashkent(t.asOf)) ? (
        <>
          {t.draft && (
            <div className="oc-ai-draft">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="m-0 min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{t.draft.title ? `${a.draft}: ${t.draft.title}` : a.draft}</h3>
                <button type="button" className="btn-quiet" onClick={() => copyDraft(t.id, t.draft!.title ? `${t.draft!.title}\n\n${t.draft!.body}` : t.draft!.body)}>
                  {copied === t.id ? a.copied : a.copy}
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
          {t.saved && (
            <p className="oc-asof" data-history={t.saved} data-tone={t.saved === "saved" ? undefined : "warn"}>
              {a.saveState[t.saved]}
            </p>
          )}
        </>
      ) : undefined,
  }));

  const notice = failure && (
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
          asking && (
            <button type="button" className="btn-quiet" disabled={pending} onClick={() => void ask(asking.q, asking.regen)}>
              {a.retry}
            </button>
          )
        )}
      </div>
    </div>
  );

  const chat = (lead?: ReactNode) => (
    <ChatShell
      lead={lead}
      labels={{
        title: a.ai,
        newChat: a.newChat,
        greeting,
        label: a.label,
        placeholder: a.placeholder,
        send: a.ask,
        sending: a.asking,
        you: a.you,
        ai: a.ai,
        copy: a.copy,
        copied: a.copied,
        copyFailed: a.copyFailed,
        regenerate: a.regenerate,
        good: a.good,
        bad: a.bad,
        keys: a.keys,
        counter: a.counter,
        disclaimer: a.noActions,
      }}
      turns={shellTurns}
      pending={pending}
      // A regenerate's question is already on screen above its answer: drawing it again would read as a second question.
      pendingQuestion={asking && !asking.regen ? asking.q : null}
      notice={notice || undefined}
      maxLength={QUESTION_MAX}
      counterFrom={COUNTER_FROM}
      inputId="owner-ai-q"
      onSend={(text) => ask(text)}
      onRegenerate={() => {
        const last = turns[turns.length - 1];
        if (last) void ask(last.q, true);
      }}
      onNewChat={clearAll}
    />
  );

  if (!history) return chat();
  return (
    <ChatHistoryFrame
      labels={a.history}
      source={source}
      storageKey="ns.owner-ai.history-collapsed"
      activeId={activeId}
      busy={pending || opening}
      reloadKey={reloadKey}
      onSelect={openSession}
      onNewChat={clearAll}
      onRemoved={(id) => {
        if (sessionId.current === id) clearAll();
      }}
      renderChat={chat}
    />
  );
}
