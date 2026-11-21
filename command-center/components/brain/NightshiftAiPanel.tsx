"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { takeLandingIdea } from "@/lib/brain/handoff";
import { pluralText } from "@/lib/plural";
import { runLink, type Brief, type BrainCard, type BrainSlots, type Scenario } from "@/lib/brain/logic";

/**
 * Nightshift AI, docked on the left of the Studio canvas (docs/studio/NIGHTSHIFT_AI.md). It talks only to /api/brain (the browser
 * never reaches a vendor). Its buttons ask questions, pick answers and choose a scenario; the one that spends is the existing one:
 *   - long: a LINK to the Run now form, prefilled — that form's own priced button holds and starts (CLAUDE.md rule 3);
 *   - short: "Create — N credits" posts to the film route's start (/api/films/<id>/start) at the quote the server read, with one
 *     idempotency key per press; the database re-prices and refuses with its own reason.
 * Every price shown is the server's; with none, no number is shown (rule 5). Every BRIEF change is announced to the canvas (S6b) with
 * the browser event `nightshift:brain-brief`.
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

export function NightshiftAiPanel({ channelId, channelSlug, initialSession, initialPrompt, fresh = false, takeIdea = false }: {
  channelId: string | null;
  channelSlug: string;
  initialSession?: string | null;
  initialPrompt?: string | null;
  fresh?: boolean;
  takeIdea?: boolean;
}) {
  const { t, fmt, locale } = useI18n();
  const c = t.aiChat;
  const [load, setLoad] = useState<State>({ state: "loading" });
  const [open, setOpen] = useState(true);
  const [session, setSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [card, setCard] = useState<BrainCard | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [step, setStep] = useState<string>("asking");
  const [film, setFilm] = useState<FilmReady | null>(null);
  const [text, setText] = useState(initialPrompt ?? "");
  const [own, setOwn] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [capped, setCapped] = useState(false);
  const idem = useRef<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

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

  const loadSession = useCallback(async (sid: string) => {
    const res = await fetch(`/api/brain/session/${encodeURIComponent(sid)}`, { cache: "no-store" });
    if (!res.ok) return false;
    const d = await res.json();
    setSession(sid);
    setStep(d.session?.step ?? "asking");
    setCard(d.card ?? null);
    setBrief(d.brief && d.brief.version === 1 ? d.brief : null);
    setMessages((d.messages ?? []).map((m: { id: number; role: "user" | "assistant"; content: string; payload?: { scenarios?: Scenario[]; factsState?: string } | null }) => ({
      key: `m${m.id}`, role: m.role, content: m.content, scenarios: m.payload?.scenarios, factsState: m.payload?.factsState,
    })));
    return true;
  }, []);

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
    if (idea) setText((cur) => cur || idea);
    const u = new URL(window.location.href);
    u.searchParams.delete("idea");
    u.searchParams.delete("ai");
    window.history.replaceState(null, "", u.toString());
  }, [takeIdea]);
  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest" });
  }, [messages.length, card]);

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
    if (d.quota && typeof d.quota === "object" && load.state === "ready") {
      const q = d.quota as { used: number; limit: number | null; trial_left?: number | null };
      setLoad({ ...load, plan: { ...load.plan, used: q.used, limit: q.limit, trial_left: q.trial_left ?? null } });
    }
    return { res, d };
  };

  const takeTurn = (d: Record<string, unknown>, sid: string) => {
    setStep(String(d.step ?? "asking"));
    setCard((d.card as BrainCard | null) ?? null);
    setMessages((m) => [...m, { key: `a${Date.now()}`, role: "assistant", content: String(d.reply ?? ""), scenarios: (d.scenarios as Scenario[]) ?? [], factsState: d.factsState as string }]);
    announce(sid, (d.brief as Brief) ?? null);
  };

  const run = async (label: string, body: Record<string, unknown>, again: () => void) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      if (label) setMessages((m) => [...m, { key: `u${Date.now()}`, role: "user", content: label }]);
      const { res, d } = await post(body);
      if (res.status === 409 && d.error === "duplicate_request") {
        // That press already went through (a network retry): show what the server has, add nothing.
        const sid = (d.session as { id?: string } | undefined)?.id ?? session;
        if (sid) await loadSession(sid);
        return;
      }
      if (!res.ok) {
        if (d.error === "chat_daily_cap") setCapped(true);
        const sid = (d.session as { id?: string } | undefined)?.id ?? session;
        if (sid && !session) setSession(sid);
        const retryable = res.status !== 401 && !NO_RETRY.includes(String(d.error));
        // A turn that was taken (the server reports its quota) already stored the message: retry it as it is, never a second copy.
        // One that was not is sent again without a second bubble: the person's words are already on screen.
        const taken = !!d.quota && !!sid;
        setProblem({ text: explain(res.status, d), retry: retryable ? (taken ? () => void run("", { action: "retry", session: sid }, again) : () => void run("", body, again)) : null });
        return;
      }
      const sid = (d.session as { id?: string } | undefined)?.id ?? session;
      if (sid && !session) setSession(sid);
      if (d.reply && sid) takeTurn(d, sid);
      else if (sid) announce(sid, null);
    } catch {
      setProblem({ text: c.errors.unavailable, retry: () => void run("", body, again) });
    } finally {
      setBusy(false);
    }
  };

  const send = (raw: string) => {
    const words = raw.trim();
    if (!words || capped) return;
    setText("");
    const request_id = pressId();
    const body = session ? { action: "turn", session, text: words, request_id } : { action: "start", channel: channelId, prompt: words, request_id };
    void run(words, body, () => send(words));
  };
  const answer = (choice: number | null) => {
    if (!card || !session) return;
    const label = choice ? card.options[choice - 1] : own.trim();
    if (!label) return;
    setOwn("");
    const body = { action: "answer", session, card: card.id, request_id: pressId(), ...(choice ? { choice } : { own: label }) };
    void run(label, body, () => answer(choice));
  };
  const choose = async (index: number) => {
    if (!session || busy) return;
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
      setBusy(false);
    }
  };
  const createFilm = async () => {
    if (!film?.quote?.quote_id || !session || busy) return;
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
    if (typeof window !== "undefined") {
      const u = new URL(window.location.href);
      u.searchParams.delete("brain");
      window.history.replaceState(null, "", u.toString());
    }
  };

  if (load.state === "hidden") return null;
  const lengthLabel = (s: number) => (s >= 60 ? fmt(c.minutes, { n: Math.round((s / 60) * 10) / 10 }) : fmt(c.seconds, { n: s }));
  const title = messages.find((m) => m.role === "user")?.content.slice(0, 40) || c.title;
  // No Brain on this plan: the lifetime trial while it lasts, then the upgrade.
  const trial = load.state === "ready" && load.plan.limit === null && (load.plan.trial_left ?? 0) > 0 ? load.plan.trial_left : null;
  // A plan whose price could not be read, or a short plan whose film quote is not on screen (a reload): its scenarios come back to
  // choose again, which re-reads the same draft and quote (the draft's idempotency key is the session and the scenario).
  const rechoose = step === "ready" && (brief?.price?.state === "failed" || (brief?.kind === "short" && !film?.quote));
  const lastReply = [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const noBrain = load.state === "ready" && load.plan.limit === null && trial === null;
  // The trial's last answer stays on screen; only the box closes (a conversation that vanished on its last reply is a dead end).
  const locked = noBrain && messages.length === 0;
  const down = load.state === "ready" && load.model !== "available";
  const viewer = load.state === "ready" && !load.canEdit;
  const disabled = busy || capped || noBrain || down || viewer;

  return (
    <aside className="studio-surface flex min-w-0 flex-col gap-3 p-4" aria-labelledby="ns-ai-title" data-testid="nightshift-ai-panel">
      <header className="flex items-center justify-between gap-2">
        <h2 id="ns-ai-title" className="truncate text-sm font-semibold text-[var(--color-fg)]">{session ? title : c.title}</h2>
        <div className="flex items-center gap-1">
          {session && <button type="button" className="btn-quiet min-h-11 whitespace-nowrap px-3 text-sm" aria-label={c.newChatLabel} onClick={newChat} disabled={busy}>{c.newChat}</button>}
          <button type="button" className="btn-quiet min-h-11 whitespace-nowrap px-3 text-sm" aria-expanded={open} aria-controls="ns-ai-body" onClick={() => setOpen((o) => !o)}>
            {open ? c.close : c.show}
          </button>
        </div>
      </header>
      {open && (
        <div id="ns-ai-body" className="flex min-w-0 flex-col gap-3">
          {!session && <p className="text-xs text-[var(--color-muted)]">{c.subtitle}</p>}
          {load.state === "loading" && <p className="text-xs text-[var(--color-muted)]" role="status">{c.loading}</p>}
          {load.state === "not_enabled" && <p className="text-sm" role="status">{c.errors.not_enabled}</p>}
          {load.state === "session_ended" && (
            <div className="flex flex-col gap-2" role="alert">
              <p className="text-sm">{c.errors.session_ended}</p>
              <Link className="btn-primary inline-flex min-h-11 items-center justify-center px-4 text-sm"
                    href={`/login?next=${encodeURIComponent(typeof window === "undefined" ? `/${channelSlug}/studio` : window.location.pathname + window.location.search)}`}>{c.signIn}</Link>
            </div>
          )}
          {capped && load.state === "ready" && load.plan.limit !== null && !problem && (
            <p className="text-sm" role="status">{fmt(c.errors.chat_daily_cap, { used: load.plan.used ?? load.plan.limit, limit: load.plan.limit })}</p>
          )}
          {load.state === "failed" && (
            <div className="flex flex-wrap items-center gap-2" role="alert">
              <p className="text-sm">{c.errors.unavailable}</p>
              <button type="button" className="btn-quiet min-h-11 px-3 text-sm" onClick={() => void read()}>{c.retry}</button>
            </div>
          )}
          {noBrain && (
            <div className="flex flex-col gap-2" role="note">
              <p className="text-sm">{c.planLocked}</p>
              <Link className="btn-primary inline-flex min-h-11 items-center justify-center px-4 text-sm" href={`/${encodeURIComponent(channelSlug)}/credits#plans`}>{c.upgrade}</Link>
            </div>
          )}
          {down && !locked && <p className="text-sm" role="status">{c.errors.assistant_unavailable}</p>}
          {viewer && !locked && <p className="text-sm" role="status">{c.viewerOnly}</p>}

          {load.state === "ready" && !locked && (
            <>
              {/* One live region with only the newest news: a live list would read the whole history out on every load. */}
              <p className="sr-only" aria-live="polite">{busy ? c.sending : lastReply}</p>
              <ol ref={listRef} className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto">
                {messages.length === 0 && <li className="text-xs text-[var(--color-muted)]">{c.empty}</li>}
                {messages.map((m, i) => (
                  <li key={m.key} className={m.role === "user" ? "self-end max-w-[85%]" : "max-w-full"}>
                    <p className="text-xs text-[var(--color-muted)]">{m.role === "user" ? c.you : c.ai}</p>
                    <p className="studio-field whitespace-pre-wrap break-words p-3 text-sm">{m.content}</p>
                    {m.role === "assistant" && m.factsState === "none" && !!m.scenarios?.length && <p className="mt-1 text-xs text-[var(--color-muted)]">{c.factsNone}</p>}
                    {m.role === "assistant" && m.factsState === "unknown" && !!m.scenarios?.length && <p className="mt-1 text-xs text-[var(--color-muted)]">{c.factsUnknown}</p>}
                    {m.role === "assistant" && i === messages.length - 1 && (step === "proposing" || rechoose) && (m.scenarios ?? []).map((s, k) => (
                      <article key={k} className="studio-field mt-2 flex flex-col gap-1 p-3">
                        <h3 className="text-sm font-semibold text-[var(--color-fg)]">{s.title}</h3>
                        <p className="text-sm">{s.idea}</p>
                        {s.story?.conflict && <p className="text-xs text-[var(--color-muted)]">{s.story.conflict}</p>}
                        <p className="text-xs text-[var(--color-muted)]">
                          {fmt(c.scenarioFacts, { len: lengthLabel(s.target_seconds), scenes: s.scenes.length, characters: s.characters.length })}
                        </p>
                        <button type="button" className="btn-quiet mt-1 min-h-11 px-4 text-sm" disabled={disabled} onClick={() => void choose(k)}>{c.chooseThis}</button>
                      </article>
                    ))}
                  </li>
                ))}
                {busy && <li className="text-xs text-[var(--color-muted)]" aria-hidden="true">{c.sending}</li>}
              </ol>

              {card && step === "asking" && (
                <fieldset className="studio-field flex min-w-0 flex-col gap-2 p-3" disabled={disabled}>
                  {card.thread_title && <legend className="studio-label">{card.thread_title}</legend>}
                  <p className="text-sm font-semibold">{card.question || c.slotQuestions[card.slot]}</p>
                  {card.options.map((o, i) => (
                    <button key={i} type="button" className="btn-quiet flex min-h-11 !items-start !justify-start gap-2 px-3 text-left text-sm" onClick={() => answer(i + 1)}>
                      <span className="font-semibold">{i + 1}</span> <span className="break-words">{o}</span>
                    </button>
                  ))}
                  <label className="sr-only" htmlFor="ns-ai-own">{c.ownAnswer}</label>
                  <div className="flex gap-2">
                    <input id="ns-ai-own" className="studio-field min-h-11 min-w-0 flex-1 px-3 text-base" placeholder={c.ownAnswer} value={own}
                           onChange={(e) => setOwn(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); answer(null); } }} />
                    <button type="button" className="btn-primary min-h-11 px-4 text-sm disabled:opacity-40" disabled={!own.trim()} onClick={() => answer(null)}>{c.confirm}</button>
                  </div>
                  {card.slot === "target_seconds" && brief?.kind === "short" && <p className="text-xs text-[var(--color-muted)]">{c.shortMinNote}</p>}
                </fieldset>
              )}

              {step === "ready" && brief && <ReadyBlock brief={brief} film={film} channelSlug={channelSlug} lengthLabel={lengthLabel} busy={busy} canRun={load.canRun} onCreateFilm={() => void createFilm()} />}

              {problem && (
                <div className="flex flex-wrap items-center gap-2" role="alert">
                  <p className="text-sm">{problem.text}</p>
                  {problem.retry && <button type="button" className="btn-quiet min-h-11 px-3 text-sm" onClick={problem.retry} disabled={busy}>{c.retry}</button>}
                </div>
              )}

              {/* At the plan too: "fewer scenes", "shorter" or another idea is typed here (a plan with no way to change it is a dead end). */}
              {(!card || step !== "asking") && step !== "created" && (
                <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); send(text); }}>
                  <label className="sr-only" htmlFor="ns-ai-input">{c.placeholder}</label>
                  <textarea id="ns-ai-input" className="studio-field min-h-[5rem] w-full p-3 text-base" value={text} maxLength={load.plan.max_input_chars}
                            placeholder={c.placeholder} disabled={disabled} onChange={(e) => setText(e.target.value)} aria-describedby="ns-ai-count"
                            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text); } }} />
                  {/* The limit is shown, never applied silently (Lens on 0199). */}
                  <p id="ns-ai-count" className="self-end text-xs text-[var(--color-muted)]">{fmt(c.charCount, { n: Array.from(text).length, max: load.plan.max_input_chars })}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="submit" className="btn-primary min-h-11 px-4 text-sm disabled:opacity-40" disabled={disabled || !text.trim()}>{busy ? c.sending : c.send}</button>
                    {load.plan.limit !== null && load.plan.used !== null && (
                      <span className="text-xs text-[var(--color-muted)]">{fmt(c.quota, { used: load.plan.used, limit: load.plan.limit })}</span>
                    )}
                    {trial !== null && (
                      <span className="text-xs text-[var(--color-muted)]">
                        {pluralText(c.trialLeft, trial, locale)}{" "}
                        <Link className="inline-flex min-h-11 items-center px-2 underline" href={`/${encodeURIComponent(channelSlug)}/credits#plans`}>{c.upgrade}</Link>
                      </span>
                    )}
                  </div>
                </form>
              )}
            </>
          )}
        </div>
      )}
    </aside>
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
