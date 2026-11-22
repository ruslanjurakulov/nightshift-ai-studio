"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { takeLandingIdea } from "@/lib/brain/handoff";
import { pluralText } from "@/lib/plural";
import { runLink, type Brief, type BrainCard, type BrainSlots, type Scenario } from "@/lib/brain/logic";
import { ChatShell, type ChatTurn } from "@/components/chat/ChatShell";
import { ChatHistoryFrame, type ChatHistorySource, type HistoryResult } from "@/components/chat/ChatHistory";
import "./nightshift-ai-panel.css";

/**
 * Nightshift AI, docked on the left of the Studio canvas (docs/studio/NIGHTSHIFT_AI.md), drawn in the same shell as the owner's
 * (components/chat): the bare N, "Salom, {name}", the pill composer, Copy and the thumbs, the aurora while an answer is on its way,
 * and the person's own stored conversations (0199) in the history drawer. The shell draws; this file owns the route, the meter and
 * every refusal, as the owner's console does for its own.
 *
 * It talks only to /api/brain (the browser never reaches a vendor) and lists and opens conversations only through
 * /api/brain/history, which pins them to this workspace, this channel and this person. Its buttons ask questions, pick answers and
 * choose a scenario; the one that spends is the existing one:
 *   - long: a LINK to the Run now form, prefilled — that form's own priced button holds and starts (CLAUDE.md rule 3);
 *   - short: "Create — N credits" posts to the film route's start (/api/films/<id>/start) at the quote the server read, with one
 *     idempotency key per press; the database re-prices and refuses with its own reason.
 * Every price shown is the server's; with none, no number is shown (rule 5). Every BRIEF change is announced to the canvas (S6b) with
 * the browser event `nightshift:brain-brief`.
 *
 * No Regenerate: the conversation is stored turn by turn and each turn moves the plan on, so an answer cannot be swapped for another
 * (asking again would store the question twice and answer it from the next step). Rename and delete are not offered either: 0199
 * has no function for them, and the panel shows nothing that does not work.
 */

type Plan = { used: number | null; limit: number | null; trial_left: number | null; max_input_chars: number };
type Msg = { key: string; role: "user" | "assistant"; content: string; scenarios?: Scenario[]; factsState?: string };
type State =
  | { state: "loading" }
  | { state: "hidden" }
  | { state: "failed" }
  | { state: "not_enabled" }
  | { state: "session_ended" }
  | { state: "ready"; plan: Plan; model: string; canEdit: boolean; canRun: boolean };
type FilmReady = { id: string; quote: { quote_id: string | null; total: number | null; startable: boolean; refusal: string | null; blocked_by: string[]; exempt: boolean } | null };
type Problem = { text: string; retry: (() => void) | null } | null;
/** Refusals a Retry cannot change: the same press would meet the same answer. */
const NO_RETRY = ["chat_daily_cap", "chat_plan_required", "message_too_long", "session_closed", "short_not_available", "channel_required", "nothing_to_choose", "forbidden", "content_refused", "output_too_long"];
/** One id per press, kept on that press's retries: the server answers a repeat of it as a duplicate, never a second message. */
const pressId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const HISTORY_ROUTE = "/api/brain/history";
const INPUT_ID = "ns-ai-input";

type StoredMessage = { id: number; role: "user" | "assistant"; content: string; payload?: { scenarios?: Scenario[]; factsState?: string } | null };
type PairedTurn = { key: string; q: string; a: string; msg: Msg | null };

/** The stored messages as the shell's question-and-answer turns. A conversation can open with the assistant (no question above it),
 *  and a question whose answer was never stored keeps a line saying so, rather than vanishing or borrowing the next answer. */
export function pairTurns(messages: Msg[], noAnswer: string): PairedTurn[] {
  const out: PairedTurn[] = [];
  let q: Msg | null = null;
  for (const m of messages) {
    if (m.role === "user") {
      if (q) out.push({ key: `${q.key}-none`, q: q.content, a: noAnswer, msg: null });
      q = m;
    } else {
      out.push({ key: m.key, q: q?.content ?? "", a: m.content, msg: m });
      q = null;
    }
  }
  if (q) out.push({ key: `${q.key}-none`, q: q.content, a: noAnswer, msg: null });
  return out;
}

export function NightshiftAiPanel({ channelId, channelSlug, greetingName = null, initialSession, initialPrompt, fresh = false, takeIdea = false }: {
  channelId: string | null;
  channelSlug: string;
  /** The first name the greeting uses (lib/owner-console/greeting.ts firstNameOf); none: a plain hello, never an address. */
  greetingName?: string | null;
  initialSession?: string | null;
  initialPrompt?: string | null;
  fresh?: boolean;
  takeIdea?: boolean;
}) {
  const { t, fmt, locale } = useI18n();
  const c = t.aiChat;
  const [load, setLoad] = useState<State>({ state: "loading" });
  const [session, setSessionState] = useState<string | null>(null);
  // A mirror of `session` for the closures a Retry keeps: one made before a Start returned its id must still continue that chat.
  const sessionRef = useRef<string | null>(null);
  const setSession = useCallback((sid: string | null) => {
    sessionRef.current = sid;
    setSessionState(sid);
  }, []);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [card, setCard] = useState<BrainCard | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [step, setStep] = useState<string>("asking");
  const [film, setFilm] = useState<FilmReady | null>(null);
  const [prefill, setPrefill] = useState<string | null>(initialPrompt ?? null);
  const [busy, setBusy] = useState(false);
  /** The words in flight, or the ones whose turn failed: drawn as the person's bubble under the thread until answered. */
  const [asking, setAsking] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [capped, setCapped] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [opening, setOpening] = useState(false);
  // A ref, not state: two presses before the re-render must not both pass (each would be a turn on the meter).
  const inFlight = useRef(false);
  const idem = useRef<string | null>(null);
  const keySeq = useRef(0);
  const localKey = (p: string) => `${p}${Date.now().toString(36)}-${++keySeq.current}`;
  // The shell's ids are numbers, stable per message: a thumb given to one answer stays on that answer, never on the next chat's.
  const turnIds = useRef(new Map<string, number>());
  const idFor = (key: string) => {
    let id = turnIds.current.get(key);
    if (id === undefined) {
      id = turnIds.current.size + 1;
      turnIds.current.set(key, id);
    }
    return id;
  };

  const announce = useCallback((sid: string, b: Brief | null) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("nightshift:brain-brief", { detail: { session_id: sid, updated_at: new Date().toISOString() } }));
    const u = new URL(window.location.href);
    if (u.searchParams.get("brain") !== sid) {
      u.searchParams.set("brain", sid);
      window.history.replaceState(null, "", u.toString());
    }
    if (b) setBrief(b);
  }, []);

  const historyUrl = useCallback(
    (extra: string) => `${HISTORY_ROUTE}?${[channelId ? `channel=${encodeURIComponent(channelId)}` : "", extra].filter(Boolean).join("&")}`,
    [channelId],
  );

  const historyCall = useCallback(
    async <T,>(url: string, read: (b: Record<string, unknown>) => T): Promise<HistoryResult<T>> => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (res.ok && body) return { ok: true, value: read(body) };
        const err = typeof body?.error === "string" ? body.error : "";
        if (err === "gone") return { ok: false, gone: true, message: c.history.gone };
        if (res.status === 401) return { ok: false, message: c.errors.session_ended };
        if (err === "not_enabled") return { ok: false, message: c.errors.not_enabled };
        return { ok: false, message: c.history.failed };
      } catch {
        return { ok: false, message: c.history.network };
      }
    },
    [c],
  );

  /** One of this person's conversations here, through the scoped history route; switching to another clears the last one's film. */
  const loadSession = useCallback(
    async (sid: string): Promise<HistoryResult<null>> => {
      const r = await historyCall(historyUrl(`session=${encodeURIComponent(sid)}`), (b) => b);
      if (!r.ok) return r;
      const d = r.value as { session?: { step?: string }; card?: BrainCard | null; brief?: Brief | null; messages?: StoredMessage[] };
      if (sessionRef.current !== sid) setFilm(null);
      setSession(sid);
      setStep(d.session?.step ?? "asking");
      setCard(d.card ?? null);
      setBrief(d.brief && d.brief.version === 1 ? d.brief : null);
      setMessages((d.messages ?? []).map((m) => ({
        key: `m${m.id}`, role: m.role, content: m.content, scenarios: m.payload?.scenarios, factsState: m.payload?.factsState,
      })));
      return { ok: true, value: null };
    },
    [historyCall, historyUrl, setSession],
  );

  const read = useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      const res = await fetch(`/api/brain${channelId ? `?channel=${encodeURIComponent(channelId)}` : ""}`, { cache: "no-store" });
      if (res.status === 404) return setLoad({ state: "hidden" });
      // An expired sign-in is said as such, with the way back; a Retry would only meet the same 401.
      if (res.status === 401) return setLoad({ state: "session_ended" });
      const d = await res.json().catch(() => ({}));
      if (res.status === 503 && d.error === "not_enabled") return setLoad({ state: "not_enabled" });
      if (!res.ok) return setLoad({ state: "failed" });
      setLoad({ state: "ready", plan: d.plan, model: d.model, canEdit: d.canEdit === true, canRun: d.canRun === true });
      setCapped(d.plan?.limit !== null && typeof d.plan?.used === "number" && d.plan.used >= d.plan.limit);
      const sid = initialSession || (fresh ? null : d.session?.id) || null;
      // A link to a conversation that is not this person's here (another workspace or channel) opens nothing: a new chat.
      if (sid) await loadSession(sid);
    } catch {
      setLoad({ state: "failed" });
    }
  }, [channelId, initialSession, fresh, loadSession]);

  useEffect(() => {
    void read();
  }, [read]);
  // The landing page's idea: put in the box once, for the person to send (or not). Nothing is sent on their behalf.
  useEffect(() => {
    if (!takeIdea || typeof window === "undefined") return;
    let store: Storage | null = null;
    try {
      store = window.localStorage;
    } catch {
      store = null;
    }
    const idea = takeLandingIdea(store);
    if (idea) setPrefill(idea);
    const u = new URL(window.location.href);
    u.searchParams.delete("idea");
    u.searchParams.delete("ai");
    window.history.replaceState(null, "", u.toString());
  }, [takeIdea]);

  const explain = (status: number, d: Record<string, unknown>): string => {
    const e = typeof d.error === "string" ? d.error : "";
    if (status === 401) return c.errors.session_ended;
    if (e === "chat_daily_cap") {
      return typeof d.used === "number" && typeof d.limit === "number" ? fmt(c.errors.chat_daily_cap, { used: d.used, limit: d.limit }) : c.errors.chat_daily_cap_plain;
    }
    if (e === "chat_plan_required") return c.planLocked;
    if (e === "message_too_long") return fmt(c.errors.message_too_long, { max: load.state === "ready" ? load.plan.max_input_chars : 2000 });
    if (e === "short_not_available") return c.shortComingSoon;
    if (e === "channel_required") return c.errors.channel_required;
    if (e === "content_refused") return c.errors.content_refused;
    if (e === "output_too_long") return c.errors.output_too_long;
    if (e === "nothing_to_choose") return c.errors.nothing_to_choose;
    if (e === "film_refused") return c.errors.film_refused;
    if (e === "not_enabled") return c.errors.not_enabled;
    if (e === "adult_only_service") return c.errors.adult_only_service;
    if (e === "session_closed") return c.errors.session_closed;
    if (e === "card_changed") return c.errors.card_changed;
    // The model is the owner's choice and hidden from customers: any model failure reads as "unavailable right now".
    if (e === "model_failed" || e === "model_unavailable" || e === "model_answer_invalid") return c.errors.assistant_unavailable;
    return c.errors.unavailable;
  };

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/brain/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (d.quota && typeof d.quota === "object") {
      const q = d.quota as { used: number; limit: number | null; trial_left?: number | null };
      setLoad((cur) => (cur.state === "ready" ? { ...cur, plan: { ...cur.plan, used: q.used, limit: q.limit, trial_left: q.trial_left ?? null } } : cur));
    }
    return { res, d };
  };

  // A chooser or Create button is disabled for its turn, which drops focus to <body>: it goes to the box once the turn is over, and
  // only then (focus a person put elsewhere on the page stays there).
  const refocus = () => {
    if (typeof document === "undefined" || document.activeElement !== document.body) return;
    (document.getElementById(INPUT_ID) as HTMLTextAreaElement | null)?.focus();
  };

  /** One turn. `label` is the person's words for it (their message, the option they picked); it stays on screen if the turn fails. */
  const run = async (label: string, body: Record<string, unknown>): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    setAsking(label || null);
    try {
      const { res, d } = await post(body);
      const sid = (d.session as { id?: string } | undefined)?.id ?? sessionRef.current;
      if (res.status === 409 && d.error === "duplicate_request") {
        // That press already went through (a network retry): show what the server has, add nothing.
        if (sid) await loadSession(sid);
        setAsking(null);
        return true;
      }
      // A chat the server just created is listed straight away.
      const isNew = !!sid && sid !== sessionRef.current;
      if (isNew) {
        setSession(sid);
        setReloadKey((k) => k + 1);
      }
      if (!res.ok) {
        if (d.error === "chat_daily_cap") setCapped(true);
        const retryable = res.status !== 401 && !NO_RETRY.includes(String(d.error));
        // A turn that was taken (the server reports its quota) already stored the message: retry it as it is, never a second copy.
        // One that was not is sent again with the same press id: a press that did land is answered as a duplicate.
        const taken = !!d.quota && !!sid;
        setProblem({ text: explain(res.status, d), retry: retryable ? (taken ? () => void run(label, { action: "retry", session: sid }) : () => void run(label, body)) : null });
        return false;
      }
      if (d.reply && sid) {
        setStep(String(d.step ?? "asking"));
        setCard((d.card as BrainCard | null) ?? null);
        setMessages((m) => [
          ...m,
          ...(label ? [{ key: localKey("u"), role: "user" as const, content: label }] : []),
          { key: localKey("a"), role: "assistant" as const, content: String(d.reply ?? ""), scenarios: (d.scenarios as Scenario[]) ?? [], factsState: d.factsState as string },
        ]);
        announce(sid, (d.brief as Brief) ?? null);
      } else if (sid) announce(sid, null);
      setAsking(null);
      return true;
    } catch {
      setProblem({ text: c.errors.unavailable, retry: () => void run(label, body) });
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const answer = (choice: number | null, ownWords = ""): Promise<boolean> => {
    if (!card || !session) return Promise.resolve(false);
    const label = choice ? card.options[choice - 1] : ownWords.trim();
    if (!label) return Promise.resolve(false);
    return run(label, { action: "answer", session, card: card.id, request_id: pressId(), ...(choice ? { choice } : { own: label }) });
  };
  const send = (raw: string): Promise<boolean> => {
    const words = raw.trim();
    if (!words || capped) return Promise.resolve(false);
    // While a question card is open the box is its "own answer" (the card's options are buttons above it).
    if (card && step === "asking" && session) return answer(null, words);
    const request_id = pressId();
    return run(words, session ? { action: "turn", session, text: words, request_id } : { action: "start", channel: channelId, prompt: words, request_id });
  };
  const choose = async (index: number) => {
    if (!session || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const { res, d } = await post({ action: "choose", session, index });
      if (!res.ok) {
        setProblem({ text: explain(res.status, d), retry: res.status === 401 || NO_RETRY.includes(String(d.error)) ? null : () => void choose(index) });
        return;
      }
      setStep("ready");
      setFilm(d.film ? { id: (d.film as { id: string }).id, quote: (d.quote as FilmReady["quote"]) ?? null } : null);
      idem.current = null;
      announce(session, d.brief as Brief);
    } catch {
      setProblem({ text: c.errors.unavailable, retry: () => void choose(index) });
    } finally {
      inFlight.current = false;
      setBusy(false);
      setTimeout(refocus, 0);
    }
  };
  const createFilm = async () => {
    if (!film?.quote?.quote_id || !session || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    // One key per press of this quote: a double press or a retry answers the first start, never a second hold.
    idem.current ??= `brain-${session.slice(0, 8)}-${Date.now().toString(36)}`;
    try {
      const res = await fetch(`/api/films/${encodeURIComponent(film.id)}/start`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quote_id: film.quote.quote_id, idem: idem.current }),
      });
      const d = (await res.json().catch(() => ({}))) as { start?: { ok?: boolean; reason?: string } };
      if (!res.ok || !d.start?.ok) {
        // The film route's own reason, in the person's language (never a raw code): the Studio timeline's words for it.
        const reasons = t.studioTimeline.startFailed as Record<string, string>;
        const reason = d.start?.reason;
        // An own key only ("constructor" is not a reason).
        setProblem({ text: reason ? (Object.prototype.hasOwnProperty.call(reasons, reason) ? reasons[reason] : reasons.other) : c.errors.unavailable, retry: null });
        return;
      }
      await post({ action: "handoff", session, handoff: { kind: "film", film_id: film.id } });
      window.location.assign(`/${encodeURIComponent(channelSlug)}/studio?view=live&film=${encodeURIComponent(film.id)}`);
    } catch {
      setProblem({ text: c.errors.unavailable, retry: null });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const newChat = () => {
    setSession(null);
    setMessages([]);
    setCard(null);
    setBrief(null);
    setFilm(null);
    setStep("asking");
    setProblem(null);
    setAsking(null);
    if (typeof window !== "undefined") {
      const u = new URL(window.location.href);
      u.searchParams.delete("brain");
      window.history.replaceState(null, "", u.toString());
    }
  };

  const source = useMemo<ChatHistorySource>(
    () => ({
      list: (before) =>
        historyCall(historyUrl(before ? `before=${encodeURIComponent(before)}` : ""), (b) => ({
          items: (Array.isArray(b.sessions) ? (b.sessions as { id: string; title: string; updated_at: string }[]) : []).map((r) => ({
            id: r.id,
            title: r.title,
            updatedAt: r.updated_at,
          })),
          nextBefore: typeof b.next_before === "string" ? b.next_before : null,
        })),
    }),
    [historyCall, historyUrl],
  );

  async function openSession(id: string): Promise<HistoryResult<null>> {
    if (inFlight.current) return { ok: true, value: null };
    setOpening(true);
    const r = await loadSession(id);
    setOpening(false);
    if (!r.ok) {
      // The chat on screen is no longer this person's here: the next message must not try to continue it.
      if (r.gone && sessionRef.current === id) newChat();
      return r;
    }
    setProblem(null);
    setAsking(null);
    announce(id, null);
    return r;
  }

  if (load.state === "hidden") return null;
  const lengthLabel = (s: number) => (s >= 60 ? fmt(c.minutes, { n: Math.round((s / 60) * 10) / 10 }) : fmt(c.seconds, { n: s }));
  const ready = load.state === "ready";
  // No Brain on this plan: the lifetime trial while it lasts, then the upgrade.
  const trial = ready && load.plan.limit === null && (load.plan.trial_left ?? 0) > 0 ? load.plan.trial_left : null;
  // A plan whose price could not be read, or a short plan whose film quote is not on screen (a reload): its scenarios come back to
  // choose again, which re-reads the same draft and quote (the draft's idempotency key is the session and the scenario).
  const rechoose = step === "ready" && (brief?.price?.state === "failed" || (brief?.kind === "short" && !film?.quote));
  const noBrain = ready && load.plan.limit === null && trial === null;
  const down = ready && load.model !== "available";
  const viewer = ready && !load.canEdit;
  const closed = step === "created";
  // The box cannot be used at all: the status above it says why and what to do.
  const blocked = !ready || capped || noBrain || down || viewer || closed;
  const disabled = busy || blocked;
  const plansHref = `/${encodeURIComponent(channelSlug)}/credits#plans`;
  const maxChars = ready ? load.plan.max_input_chars : 2000;

  const status: ReactNode = (() => {
    if (load.state === "loading") return <p role="status">{c.loading}</p>;
    if (load.state === "failed")
      return (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p>{c.errors.unavailable}</p>
          <button type="button" className="btn-quiet min-h-11 px-3 text-sm" onClick={() => void read()}>{c.retry}</button>
        </div>
      );
    if (load.state === "not_enabled") return <p role="status">{c.errors.not_enabled}</p>;
    if (load.state === "session_ended")
      return (
        <div role="alert" className="flex flex-col gap-2">
          <p>{c.errors.session_ended}</p>
          <Link className="btn-primary inline-flex min-h-11 items-center justify-center px-4 text-sm"
                href={`/login?next=${encodeURIComponent(typeof window === "undefined" ? `/${channelSlug}/studio` : window.location.pathname + window.location.search)}`}>{c.signIn}</Link>
        </div>
      );
    if (noBrain)
      return (
        <div role="note" className="flex flex-col gap-2">
          <p>{c.planLocked}</p>
          <Link className="btn-primary inline-flex min-h-11 items-center justify-center px-4 text-sm" href={plansHref}>{c.upgrade}</Link>
        </div>
      );
    // The turn's own refusal already says it in the thread: once is enough.
    if (capped && !problem)
      return <p role="status">{load.plan.limit !== null ? fmt(c.errors.chat_daily_cap, { used: load.plan.used ?? load.plan.limit, limit: load.plan.limit }) : c.errors.chat_daily_cap_plain}</p>;
    if (down) return <p role="status">{c.errors.assistant_unavailable}</p>;
    if (viewer) return <p role="status">{c.viewerOnly}</p>;
    if (closed) return <p role="status">{c.errors.session_closed}</p>;
    return null;
  })();

  const meter: ReactNode = ready && ((load.plan.limit !== null && load.plan.used !== null) || trial !== null) ? (
    <p className="chat-meter">
      {load.plan.limit !== null && load.plan.used !== null && fmt(c.quota, { used: load.plan.used, limit: load.plan.limit })}
      {trial !== null && (
        <>
          {pluralText(c.trialLeft, trial, locale)}{" "}
          <Link className="chat-meter-link" href={plansHref}>{c.upgrade}</Link>
        </>
      )}
    </p>
  ) : null;

  const paired = pairTurns(messages, c.history.noAnswer);
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") ?? null;
  const isLast = (m: Msg | null) => !!m && m === lastAssistant && messages[messages.length - 1] === m;

  // Under the newest answer: its question card, or the plan with its price and its one way on.
  const tail: ReactNode = (
    <>
      {card && step === "asking" && (
        <fieldset className="studio-field flex min-w-0 flex-col gap-2 p-3" disabled={disabled}>
          {card.thread_title && <legend className="studio-label">{card.thread_title}</legend>}
          <p className="text-sm font-semibold">{card.question || c.slotQuestions[card.slot]}</p>
          {card.options.map((o, i) => (
            <button key={i} type="button" className="btn-quiet flex min-h-11 !items-start !justify-start gap-2 px-3 text-left text-sm" onClick={() => void answer(i + 1)}>
              <span className="font-semibold">{i + 1}</span> <span className="break-words">{o}</span>
            </button>
          ))}
          {card.slot === "target_seconds" && brief?.kind === "short" && <p className="text-xs text-[var(--color-muted)]">{c.shortMinNote}</p>}
        </fieldset>
      )}
      {step === "ready" && brief && <ReadyBlock brief={brief} film={film} channelSlug={channelSlug} lengthLabel={lengthLabel} busy={busy} canRun={ready && load.canRun} onCreateFilm={() => void createFilm()} />}
    </>
  );
  const hasTail = (card && step === "asking") || (step === "ready" && brief);

  const turns: ChatTurn[] = paired.map((p, i) => {
    const m = p.msg;
    const last = i === paired.length - 1;
    const scenarios = m && isLast(m) && (step === "proposing" || rechoose) ? (m.scenarios ?? []) : [];
    const facts = m && m.scenarios?.length ? (m.factsState === "none" ? c.factsNone : m.factsState === "unknown" ? c.factsUnknown : null) : null;
    const extra = facts || scenarios.length > 0 || (last && hasTail) ? (
      <>
        {facts && <p className="chat-note">{facts}</p>}
        {scenarios.map((s, k) => (
          <article key={k} className="studio-field flex flex-col gap-1 p-3">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">{s.title}</h3>
            <p className="text-sm">{s.idea}</p>
            {s.story?.conflict && <p className="text-xs text-[var(--color-muted)]">{s.story.conflict}</p>}
            <p className="text-xs text-[var(--color-muted)]">
              {fmt(c.scenarioFacts, { len: lengthLabel(s.target_seconds), scenes: s.scenes.length, characters: s.characters.length })}
            </p>
            <button type="button" className="btn-quiet mt-1 min-h-11 px-4 text-sm" disabled={disabled} aria-label={fmt(c.chooseThisNamed, { title: s.title })} onClick={() => void choose(k)}>{c.chooseThis}</button>
          </article>
        ))}
        {last && hasTail && tail}
      </>
    ) : undefined;
    return { id: idFor(p.key), q: p.q, a: p.a, extra };
  });

  const notice: ReactNode = problem || (hasTail && turns.length === 0) ? (
    <>
      {hasTail && turns.length === 0 && tail}
      {problem && (
        <div className="ns-ai-problem" role="alert">
          <p className="m-0 flex items-start gap-2">
            <TriangleAlert aria-hidden size={16} className="ns-ai-problem-ic" />
            <span>{problem.text}</span>
          </p>
          {problem.retry && <button type="button" className="btn-quiet min-h-11 px-3 text-sm" onClick={problem.retry} disabled={busy}>{c.retry}</button>}
        </div>
      )}
    </>
  ) : undefined;

  const chat = (lead?: ReactNode) => (
    <ChatShell
      lead={lead}
      contained
      titleAs="h2"
      labels={{
        title: c.title,
        newChat: c.shell.newChat,
        greeting: greetingName ? fmt(c.shell.greeting, { name: greetingName }) : c.shell.greetingNoName,
        label: c.shell.label,
        placeholder: card && step === "asking" ? c.shell.ownAnswer : c.shell.placeholder,
        send: c.send,
        sending: c.sending,
        you: c.you,
        ai: c.ai,
        copy: c.shell.copy,
        copied: c.shell.copied,
        copyFailed: c.shell.copyFailed,
        good: c.shell.good,
        bad: c.shell.bad,
        keys: c.shell.keys,
        counter: c.shell.counter,
        disclaimer: c.shell.disclaimer,
      }}
      turns={turns}
      pending={busy}
      pendingQuestion={asking}
      notice={notice}
      maxLength={maxChars}
      // The limit is shown before it is applied, never applied silently (Lens on 0199).
      counterFrom={Math.floor(maxChars * 0.9)}
      inputId={INPUT_ID}
      onSend={send}
      onNewChat={newChat}
      disabled={blocked}
      status={status}
      meter={meter}
      prefill={prefill}
    />
  );

  return (
    <div className="ns-ai-dock" data-testid="nightshift-ai-panel">
      {ready ? (
        // The side panel is narrow: the history is the drawer at every width (a 268px column would leave no room for the chat).
        <ChatHistoryFrame
          variant="drawer"
          labels={c.history}
          source={source}
          storageKey="ns.studio-ai.history-collapsed"
          activeId={session}
          busy={busy || opening}
          reloadKey={reloadKey}
          onSelect={openSession}
          onNewChat={newChat}
          onRemoved={(id) => {
            if (sessionRef.current === id) newChat();
          }}
          renderChat={chat}
        />
      ) : (
        chat()
      )}
    </div>
  );
}

function ReadyBlock({ brief, film, channelSlug, lengthLabel, busy, canRun, onCreateFilm }: {
  brief: Brief; film: FilmReady | null; channelSlug: string; lengthLabel: (s: number) => string; busy: boolean; canRun: boolean; onCreateFilm: () => void;
}) {
  const { t, fmt, locale } = useI18n();
  const c = t.aiChat;
  const p = brief.price;
  const slots: BrainSlots = { kind: brief.kind ?? undefined };
  const credits = (n: number) => pluralText(c.price, n, locale);
  return (
    <section className="studio-field flex flex-col gap-2 p-3" aria-label={c.planReady}>
      <h3 className="text-sm font-semibold text-[var(--color-fg)]">{brief.title}</h3>
      <p className="text-sm">{brief.idea}</p>
      <p className="text-xs text-[var(--color-muted)]">{fmt(c.scenarioFacts, { len: lengthLabel(brief.target_seconds ?? 0), scenes: brief.scenes?.length ?? 0, characters: brief.characters?.length ?? 0 })}</p>
      {brief.voice.mode === "clip_audio" && <p className="text-xs text-[var(--color-muted)]">{c.clipAudioNote}</p>}
      <p className="text-sm font-semibold">
        {p?.state === "priced" && credits(p.total_credits)}
        {p?.state === "exempt" && c.priceExempt}
        {p?.state === "unpriced" && c.priceUnpriced}
        {p?.state === "failed" && c.priceFailed}
        {!p && c.priceUnpriced}
      </p>
      {p?.state === "priced" && p.spendable === "unknown" && <p className="text-xs">{c.balanceUnknown}</p>}
      {p?.state === "priced" && !p.fits && typeof p.spendable === "number" && (
        <div className="flex flex-col gap-2" role="note">
          <p className="text-sm">{fmt(c.insufficient, { len: lengthLabel(brief.target_seconds ?? 0), need: p.total_credits, have: p.spendable })}</p>
          {p.shorter && slots.kind === "long" && (
            <Link className="btn-quiet inline-flex min-h-11 items-center px-4 text-sm" href={runLink(channelSlug, { ...brief, target_seconds: p.shorter.target_seconds })}>
              {fmt(c.useShorter, { len: lengthLabel(p.shorter.target_seconds), credits: p.shorter.credits })}
            </Link>
          )}
          {!p.shorter && <p className="text-sm">{slots.kind === "long" ? c.noneFits : c.shortenFilm}</p>}
          <div className="flex flex-wrap gap-2">
            <Link className="btn-quiet inline-flex min-h-11 items-center px-4 text-sm" href={`/${encodeURIComponent(channelSlug)}/credits#plans`}>{c.upgrade}</Link>
            <Link className="btn-quiet inline-flex min-h-11 items-center px-4 text-sm" href={`/${encodeURIComponent(channelSlug)}/credits#topups`}>{c.topUp}</Link>
          </div>
        </div>
      )}
      {brief.kind === "long" && (p?.state !== "priced" || p.fits || typeof p.spendable !== "number") && (
        <>
          <Link className="btn-primary inline-flex min-h-11 items-center justify-center px-4 text-sm" href={runLink(channelSlug, brief)}>{c.openRunNow}</Link>
          <p className="text-xs text-[var(--color-muted)]">{canRun ? c.useHint : c.adminRuns}</p>
        </>
      )}
      {brief.kind === "short" && !film?.quote && <p className="text-sm">{c.chooseAgain}</p>}
      {brief.kind === "short" && film?.quote && (
        film.quote.startable && film.quote.quote_id && (film.quote.total !== null || film.quote.exempt) ? (
          <>
            <button type="button" className="btn-primary min-h-11 px-4 text-sm disabled:opacity-40" disabled={busy} onClick={onCreateFilm}>
              {film.quote.exempt ? c.createExempt : pluralText(c.createFor, film.quote.total ?? 0, locale)}
            </button>
            <p className="text-xs text-[var(--color-muted)]">{c.createHint}</p>
          </>
        ) : (
          <div className="flex flex-col gap-2" role="note">
            {/* Why it cannot start, in the person's language: the Studio timeline's words for each block (never a raw code). */}
            <p className="text-sm">{film.quote.blocked_by.length
              ? (Object.prototype.hasOwnProperty.call(t.studioTimeline.blocked, film.quote.blocked_by[0])
                  ? (t.studioTimeline.blocked as Record<string, string>)[film.quote.blocked_by[0]] : t.studioTimeline.blocked.other)
              : c.priceUnpriced}</p>
            {film.quote.blocked_by.includes("insufficient_credits") && (
              <>
                <p className="text-sm">{c.shortenFilm}</p>
                <div className="flex flex-wrap gap-2">
                  <Link className="btn-quiet inline-flex min-h-11 items-center px-4 text-sm" href={`/${encodeURIComponent(channelSlug)}/credits#plans`}>{c.upgrade}</Link>
                  <Link className="btn-quiet inline-flex min-h-11 items-center px-4 text-sm" href={`/${encodeURIComponent(channelSlug)}/credits#topups`}>{c.topUp}</Link>
                </div>
              </>
            )}
          </div>
        )
      )}
    </section>
  );
}
