"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { Pencil, TriangleAlert } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { takeLandingIdea } from "@/lib/brain/handoff";
import { pluralText } from "@/lib/plural";
import { changeOptions, isInferable, readSlots, runLink, speechOf, type Brief, type BrainCard, type BrainSlots, type InferableSlot, type Scenario } from "@/lib/brain/logic";
import { CONTACT_HREF, LEGAL } from "@/lib/legal";
import { formatCredits } from "@/lib/credits";
import { ChatShell, type ChatTurn } from "@/components/chat/ChatShell";
import { ChatHistoryFrame, type ChatHistorySource, type HistoryResult } from "@/components/chat/ChatHistory";
import { StateBlock } from "@/components/states/StateBlock";
// S2's Create (#905): the quote, the person's confirmation and the start route, with every refusal's remedy. Not redone here.
import { FilmCreateButton } from "@/components/studio-timeline/FilmCreateButton";
import { RefSheetsPanel } from "@/components/brain/RefSheetsPanel";
import { coerceQuote, type FilmQuote } from "@/lib/studio/timeline";
import { pluralForm } from "@/lib/plural";
// The gate's client-safe vocabulary (#898): the codes and their remedies are the gate's own, never retyped here.
import { CHAT_GATE_REMEDY, isChatGateError, type ChatGateRemedy, type ChatGateVerdict } from "@/lib/brain/chat-gate";
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
 *   - short: S2's FilmCreateButton (#905), given the draft and quote_film's answer: it asks the person to confirm that number and
 *     starts the film through the film route; this panel only records the handoff once it went through and opens the live view.
 * Every price shown is the server's; with none, no number is shown (rule 5). Every BRIEF change is announced to the canvas (S6b) with
 * the browser event `nightshift:brain-brief`.
 *
 * No Regenerate: the conversation is stored turn by turn and each turn moves the plan on, so an answer cannot be swapped for another
 * (asking again would store the question twice and answer it from the next step). Rename and delete are not offered either: 0199
 * has no function for them, and the panel shows nothing that does not work.
 */

/** `reserved` / `reserved_until` (0232): turns held by storyboards being written and when the last hold ends; held is not used. */
type Plan = { used: number | null; limit: number | null; trial_left: number | null; max_input_chars: number; reserved?: number; reserved_until?: string | null };
type Msg = { key: string; role: "user" | "assistant"; content: string; scenarios?: Scenario[]; factsState?: string };
type State =
  | { state: "loading" }
  | { state: "hidden" }
  | { state: "failed" }
  | { state: "not_enabled" }
  | { state: "session_ended" }
  | { state: "ready"; plan: Plan; model: string; canEdit: boolean; canRun: boolean; gate: ChatGateVerdict | null };
/** The draft the plan priced: its id, quote_film's answer as S2 reads it (coerceQuote), and which outline it came from. */
/** `version`: the film's version after the character sheets were attached (its quote is then that version's), else absent. */
type FilmReady = { id: string; quote: FilmQuote | null; index: number; version?: number };
/** The age refusals (0192) are #900's state: its words, no Retry, and the way to Create's 18+ box or support (actionFor). They
 *  never reach the gate block too, before a press or after one, so the age state is said once. */
const AGE_CODES: ReadonlySet<string> = new Set(["adult_only_service", "adult_attestation_required"]);
type GateRemedy = Exclude<ChatGateRemedy, "confirm_age">;
/** The remedy of a refusal the model's gate gave (#898 lib/brain/chat-gate), or null when it is not the gate's or is an age one. */
const gateRemedy = (e: unknown): GateRemedy | null => {
  if (!isChatGateError(e) || AGE_CODES.has(e)) return null;
  const r = CHAT_GATE_REMEDY[e];
  return r === "confirm_age" ? null : r;
};
/** A refusal with its remedy: a Retry when another press could go differently, or a link to the place the fix is made. */
type Problem = { text: string; retry: (() => void) | null; code?: string; action?: { href: string; label: string } | null;
                 /** The press's own words when they are not "Try again" ("Check again": nothing is re-sent but a question). */
                 retryLabel?: string } | null;
/** The server's choice of models for the draft (app/api/brain/turn `models`), by name; a role with none on sale is null. */
type FilmModels = { clip: { id: string; name: string } | null; keyframe: { id: string; name: string } | null };
function readModels(v: unknown): FilmModels | null {
  if (!v || typeof v !== "object") return null;
  const one = (x: unknown) => {
    const o = x && typeof x === "object" ? (x as { id?: unknown; name?: unknown }) : null;
    return o && typeof o.id === "string" && typeof o.name === "string" && o.name ? { id: o.id, name: o.name.slice(0, 80) } : null;
  };
  const m = v as { clip?: unknown; keyframe?: unknown };
  return { clip: one(m.clip), keyframe: one(m.keyframe) };
}
/** A failed plan's reasons a new attempt cannot change (Lens L7): the outline cannot fit, the model is not set up or not allowed. */
const NO_RETRY_REASONS = new Set(["not_plannable", "vendor_auth", "not_configured", "prompt_too_long", "content_refused", "plan_over_cap",
  "plan_superseded"]);
/** A film's id as the server sends it: only one of these is ever put into a link. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 0211's lease, as the history read says it (lib/server/brain/conversation.ts planState). `until` is when a running one ends. */
type PlanLease = { state: "running" | "failed" | "done" | "unknown"; reason: string | null; until: number; index: number | null; proposal: number | null };
function readLease(v: unknown): PlanLease | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { state?: unknown; reason?: unknown; expires_at?: unknown; scenario_index?: unknown; proposal_id?: unknown };
  const state = o.state === "running" || o.state === "failed" || o.state === "done" ? o.state : "unknown";
  const until = typeof o.expires_at === "string" ? Date.parse(o.expires_at) : NaN;
  return { state, reason: typeof o.reason === "string" ? o.reason : null, until: Number.isFinite(until) ? until : 0,
           index: typeof o.scenario_index === "number" ? o.scenario_index : null, proposal: typeof o.proposal_id === "number" ? o.proposal_id : null };
}
/** The history route's answer, with whether the same request could go differently a moment later (a 503, a dropped connection). */
type HistoryRead<T> = { ok: true; value: T } | { ok: false; gone?: boolean; message: string; retry: boolean };
/** Refusals a Retry cannot change: the same press would meet the same answer. */
const NO_RETRY = [
  "chat_daily_cap", "chat_plan_required", "message_too_long", "session_closed", "short_not_available", "channel_required", "nothing_to_choose",
  "forbidden", "content_refused", "output_too_long", "brief_too_large", "not_a_member",
  // The plan step's refusals another press cannot change (lib/server/brain/plan, 0211's lease).
  "plan_over_cap", "plan_running", "plan_unavailable", "plan_superseded", "proposal_outdated",
  // A project's own storyboard conversation (lib/server/brain/film-plan): it is continued in the project, never here.
  "film_conversation",
  // A scene over the models' prompt limit was already asked again once: another press spends turns on the same outline.
  "prompt_too_long",
  // The outline's looks cannot fit any shot's prompt: the same press meets the same outline (a new proposal is the remedy).
  "looks_too_long",
  // A stored storyboard that speaks where only a wordless film can be made: choosing it again meets the same refusal.
  "speech_not_available",
  // The account's own 18+ answer (0192): a Retry would meet the same refusal; the remedy is where the age is answered (Pixel on #900).
  "adult_only_service", "adult_attestation_required",
  // The gate's other refusals whose remedy is not "retry": the same press meets the same region or support case.
  ...Object.keys(CHAT_GATE_REMEDY).filter((k) => !AGE_CODES.has(k) && gateRemedy(k) !== "retry"),
];
/** One id per press, kept on that press's retries: the server answers a repeat of it as a duplicate, never a second message. */
/** The one chip-change card on screen (a chip's aria-controls). */
const CHANGE_CARD_ID = "ns-ai-change-card";
const pressId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
/**
 * A short plan is written on the server in up to a few minutes, each call a turn (lib/server/brain/plan.ts). Its press id is kept
 * in this tab's sessionStorage until the answer arrives: after a refresh the panel waits for that plan instead of offering a second
 * press, which would take the turns again. The route's own limit (maxDuration 300 s) bounds the wait.
 */
const PLAN_WAIT_MS = 310_000;
type PendingPlan = { rid: string; index: number; title: string; at: number };
const planKey = (sid: string) => `nightshift-ai-plan:${sid}`;
function pendingPlan(sid: string): PendingPlan | null {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(planKey(sid)) ?? "null") as PendingPlan | null;
    return v && typeof v.rid === "string" && typeof v.index === "number" && typeof v.title === "string" && typeof v.at === "number" ? v : null;
  } catch {
    return null;
  }
}
function keepPlan(sid: string, p: PendingPlan | null) {
  try {
    if (p) window.sessionStorage.setItem(planKey(sid), JSON.stringify(p));
    else window.sessionStorage.removeItem(planKey(sid));
  } catch {
    // No storage (private mode): the press still works; only a refresh mid-plan loses the wait.
  }
}
const HISTORY_ROUTE = "/api/brain/history";
const INPUT_ID = "ns-ai-input";

type StoredMessage = { id: number; role: "user" | "assistant"; content: string; payload?: { scenarios?: Scenario[]; factsState?: string } | null };
type PairedTurn = { key: string; q: string; a: string; msg: Msg | null };

/**
 * A choice of an outline, as the plan step stores it (the outline's title as the person's message, lib/server/brain/plan.ts): it is
 * the person's press, not a question waiting for an answer, so it is never drawn as "no saved answer" (Lens M5). While the plan runs
 * the panel draws it once (`asking`); afterwards the plan card carries the title.
 */
/**
 * A short digest of the BRIEF's characters (their looks and stages): the sheets panel is keyed on it, so a plan chosen again with
 * other characters or looks starts the panel fresh (no confirm box, no quote of the old cast left on screen; Lens M4).
 */
export function charactersKey(brief: Pick<Brief, "characters">): string {
  const text = JSON.stringify((brief.characters ?? []).map((c) => [c.id, c.name, c.look ?? null, c.age_stages ?? null]));
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function withoutChoices(messages: Msg[]): Msg[] {
  return messages.filter((m, i) => {
    if (m.role !== "user") return true;
    const prev = messages.slice(0, i).reverse().find((x) => x.role === "assistant");
    return !prev?.scenarios?.some((s) => s.title === m.content);
  });
}

/** The stored messages as the shell's question-and-answer turns. A conversation can open with the assistant (no question above it),
 *  and a question whose answer was never stored keeps a line saying so, rather than vanishing or borrowing the next answer. */
export function pairTurns(messages: Msg[], noAnswer: string): PairedTurn[] {
  const out: PairedTurn[] = [];
  let q: Msg | null = null;
  for (const m of withoutChoices(messages)) {
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
  /** The slots as the server stored them: the inferred ones are drawn as chips the person can change. */
  const [slots, setSlots] = useState<BrainSlots>({});
  /** The inferred slot whose chip was pressed: its card of the server's own options (or the box, for the audience). */
  const [changing, setChanging] = useState<InferableSlot | null>(null);
  const chipRefs = useRef<Partial<Record<InferableSlot, HTMLButtonElement | null>>>({});
  const changeCardRef = useRef<HTMLFieldSetElement | null>(null);
  /** Close a chip's card; `refocus`: back to the chip that opened it (Escape, Keep it), never to <body> (Pixel M1). */
  const closeChange = (refocus: boolean) => {
    const opener = changing;
    setChanging(null);
    if (refocus && opener) setTimeout(() => chipRefs.current[opener]?.focus(), 0);
  };
  // On open, focus goes into the card (its first option, or Keep it), and the card is scrolled into view, never below the fold.
  useEffect(() => {
    if (!changing) return;
    const card = changeCardRef.current;
    if (!card) return;
    card.scrollIntoView?.({ block: "nearest" });
    (card.querySelector("button") as HTMLButtonElement | null)?.focus();
  }, [changing]);
  /** An option as the person reads it, in the app's language; the value sent is always the server's own (Pixel m1, m4). */
  const optionLabel = (k: InferableSlot, v: string) =>
    k === "language" ? (c.languageNames as Record<string, string>)[v] ?? v : k === "aspect" ? (c.aspectNames as Record<string, string>)[v] ?? v : v;
  const [brief, setBrief] = useState<Brief | null>(null);
  const [step, setStep] = useState<string>("asking");
  const [film, setFilm] = useState<FilmReady | null>(null);
  // The models the server chose for the draft (the choose answer), named on the card; null = not chosen yet on this screen.
  const [models, setModels] = useState<FilmModels | null>(null);
  const [prefill, setPrefill] = useState<string | null>(initialPrompt ?? null);
  const [busy, setBusy] = useState(false);
  /** The words in flight, or the ones whose turn failed: drawn as the person's bubble under the thread until answered. */
  const [asking, setAsking] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [capped, setCapped] = useState(false);
  // The storyboard is being written (a short outline was chosen): its own status, never a bare "thinking".
  const [planning, setPlanning] = useState(false);
  /** The plan being waited on is another tab's (0211's plan_running), said in its own words rather than "writing". */
  const [planOther, setPlanOther] = useState(false);
  /** Aborted when the panel unmounts: a wait started by a press (choose) stops with it, never polls a closed panel (Lens M2). */
  const life = useRef<AbortController | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    life.current = ctl;
    return () => ctl.abort();
  }, []);
  const [lease, setLease] = useState<PlanLease | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [opening, setOpening] = useState(false);
  // A ref, not state: two presses before the re-render must not both pass (each would be a turn on the meter).
  const inFlight = useRef(false);
  /** The film whose start this conversation already recorded (the handoff): a replayed start, or a second one, records nothing. */
  const handedOff = useRef<string | null>(null);
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

  // A ref: the router's identity is not a reason to read the conversation again.
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  // Set when the panel itself took a gone conversation off the URL: the page comes back without ?brain=, which is no reason to
  // read again (that would open the latest conversation in place of the new chat the person was left with).
  const dropped = useRef(false);

  /** Back to a new chat, the state only (the URL is the caller's). */
  const clear = useCallback(() => {
    setSession(null);
    setMessages([]);
    setCard(null);
    setSlots({});
    setChanging(null);
    setBrief(null);
    setFilm(null);
    setModels(null);
    setLease(null);
    setStep("asking");
    setProblem(null);
    setAsking(null);
  }, [setSession]);

  /** A conversation that is not this person's here (gone): never continued, and taken off the URL. The canvas draws ?brain= from the
   *  page (LiveView), so it is a router replace, not history.replaceState: otherwise the canvas would keep drawing a conversation the
   *  panel is not showing. A replace, so Back does not return to it. */
  const forget = useCallback(
    (sid: string) => {
      if (sessionRef.current === sid) clear();
      if (typeof window === "undefined") return;
      const u = new URL(window.location.href);
      if (u.searchParams.get("brain") !== sid) return;
      u.searchParams.delete("brain");
      // Only a page that was drawn with ?brain= comes back with different props; otherwise there is no re-read to skip.
      if (initialSession) dropped.current = true;
      routerRef.current.replace(`${u.pathname}${u.search}${u.hash}`, { scroll: false });
    },
    [clear, initialSession],
  );

  const historyUrl = useCallback(
    (extra: string) => `${HISTORY_ROUTE}?${[channelId ? `channel=${encodeURIComponent(channelId)}` : "", extra].filter(Boolean).join("&")}`,
    [channelId],
  );

  const historyCall = useCallback(
    // `failed` is what a passing failure is called: opening one chat, or (the list's own words) loading the chats.
    async <T,>(url: string, read: (b: Record<string, unknown>) => T, failed: string = c.history.failed): Promise<HistoryRead<T>> => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (res.ok && body) return { ok: true, value: read(body) };
        const err = typeof body?.error === "string" ? body.error : "";
        if (err === "gone") return { ok: false, gone: true, message: c.history.gone, retry: false };
        // A refusal that the same request would meet again is said without "try again", and offers no Retry.
        if (res.status === 401) return { ok: false, message: c.errors.session_ended, retry: false };
        if (err === "not_enabled") return { ok: false, message: c.errors.not_enabled, retry: false };
        if (res.status === 403) return { ok: false, message: c.history.forbidden, retry: false };
        if (res.status === 400) return { ok: false, message: c.history.badRequest, retry: false };
        if (res.status === 404) return { ok: false, message: c.history.notHere, retry: false };
        return { ok: false, message: failed, retry: true };
      } catch {
        return { ok: false, message: c.history.network, retry: true };
      }
    },
    [c],
  );

  /** One of this person's conversations here, through the scoped history route; switching to another clears the last one's film. */
  const loadSession = useCallback(
    async (sid: string): Promise<HistoryRead<null>> => {
      const r = await historyCall(historyUrl(`session=${encodeURIComponent(sid)}`), (b) => b);
      if (!r.ok) return r;
      const d = r.value as { session?: { step?: string }; card?: BrainCard | null; brief?: Brief | null; messages?: StoredMessage[]; plan?: unknown };
      if (sessionRef.current !== sid) {
        setFilm(null);
        setModels(null);
      }
      // The plan's lease as the database keeps it (0211): what the wait below follows, across tabs and refreshes (Lens M1).
      setLease(readLease(d.plan));
      setSession(sid);
      setStep(d.session?.step ?? "asking");
      setCard(d.card ?? null);
      setSlots(readSlots((d.session as { slots?: unknown } | undefined)?.slots));
      setChanging(null);
      setBrief(d.brief && d.brief.version === 1 ? d.brief : null);
      setMessages((d.messages ?? []).map((m) => ({
        key: `m${m.id}`, role: m.role, content: m.content, scenarios: m.payload?.scenarios, factsState: m.payload?.factsState,
      })));
      return { ok: true, value: null };
    },
    [historyCall, historyUrl, setSession],
  );

  /** Retry of a conversation that could not be read: the same scoped read, in the turn's lock so it cannot race a message. */
  const reopen = useRef<(sid: string) => Promise<void>>(async () => {});
  reopen.current = async (sid: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const r = await loadSession(sid);
      if (r.ok) {
        // The words a duplicate press left on screen are in the conversation now.
        setAsking(null);
        return;
      }
      if (r.gone) {
        forget(sid);
        setReloadKey((k) => k + 1);
      }
      setProblem({ text: r.message, retry: r.retry ? () => void reopen.current(sid) : null });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

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
      // GET /api/brain's `gate` (#898): read-only, the same check a turn runs. Only a verdict in the gate's own vocabulary is taken;
      // anything else is no verdict, and the turn's own gate still refuses after a press.
      const g = d.gate && typeof d.gate === "object" ? (d.gate as { code?: unknown }) : null;
      const gate: ChatGateVerdict | null = g && isChatGateError(g.code) ? { code: g.code, remedy: CHAT_GATE_REMEDY[g.code] } : null;
      setLoad({ state: "ready", plan: d.plan, model: d.model, canEdit: d.canEdit === true, canRun: d.canRun === true, gate });
      setCapped(d.plan?.limit !== null && typeof d.plan?.used === "number" && d.plan.used >= d.plan.limit);
      const sid = initialSession || (fresh ? null : d.session?.id) || null;
      if (!sid) return;
      const r = await loadSession(sid);
      if (r.ok) return;
      // A link to a conversation that is not this person's here (another workspace or channel) opens nothing: a new chat.
      if (r.gone) forget(sid);
      // One that could not be read is said, with a Retry when another try could go differently: never a silent empty chat.
      else setProblem({ text: r.message, retry: r.retry ? () => void reopen.current(sid) : null });
    } catch {
      setLoad({ state: "failed" });
    }
  }, [channelId, initialSession, fresh, loadSession, forget]);

  // The props the last read ran with: the panel's own removal of a gone ?brain= (forget) is skipped once, any other change reads.
  const readWith = useRef<{ initialSession: string | null } | null>(null);
  useEffect(() => {
    const prev = readWith.current;
    readWith.current = { initialSession: initialSession ?? null };
    if (dropped.current && prev?.initialSession && !initialSession) {
      dropped.current = false;
      return;
    }
    void read();
  }, [read, initialSession]);

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

  /** One wording per remedy, before a press (GET's gate) and after one (a turn's refusal) alike; never the vendor's name. */
  const gateWords = (r: GateRemedy): string =>
    r === "contact_support" ? (LEGAL.contactEmail ? fmt(c.gate.contact_support, { email: LEGAL.contactEmail }) : c.gate.contact_support_no_email) : c.gate[r];
  /** S5's shared state for the gate's non-age refusals: one line and the one way on the remedy names (Retry, or support). */
  const gateBlock = (r: GateRemedy, code: string, onRetry: (() => void) | null): ReactNode => (
    <StateBlock role="alert" tone={r === "retry" ? "warn" : "fail"} compact data-gate={code} data-remedy={r}
      actions={r === "retry" && onRetry
        ? <button type="button" className="btn-quiet min-h-11 px-3 text-sm" onClick={onRetry} disabled={busy}>{c.retry}</button>
        : r === "contact_support"
          // No support address configured: the site's own contact block (lib/legal CONTACT_HREF), never no way on (Pixel P1).
          ? <a className="btn-quiet inline-flex min-h-11 items-center px-3 text-sm" href={LEGAL.contactEmail ? `mailto:${LEGAL.contactEmail}` : CONTACT_HREF}>{c.gate.contact}</a>
          : undefined}>
      {gateWords(r)}
    </StateBlock>
  );
  /** An ISO time from the server as this person's clock ("14:05"), or null when there is none to say (never a made-up time). */
  const clockOf = (v: unknown): string | null => {
    const at = typeof v === "string" ? Date.parse(v) : Number.NaN;
    return Number.isFinite(at) ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(at) : null;
  };
  const explain = (status: number, d: Record<string, unknown>): string => {
    const e = typeof d.error === "string" ? d.error : "";
    if (status === 401) return c.errors.session_ended;
    if (e === "chat_daily_cap") {
      return typeof d.used === "number" && typeof d.limit === "number" ? fmt(c.errors.chat_daily_cap, { used: d.used, limit: d.limit }) : c.errors.chat_daily_cap_plain;
    }
    // 0232: the rest is only held by a storyboard being written; it comes back by `until` (minutes), never "in 24 hours".
    if (e === "chat_reserved") {
      const at = clockOf(d.until);
      // The person's own daily limit, held by their own storyboard being written: said as theirs, with how many it holds.
      if (d.scope === "person") {
        return at && typeof d.reserved === "number" ? fmt(c.errors.chat_reserved_person, { n: d.reserved, time: at }) : c.errors.chat_reserved_person_plain;
      }
      return at ? fmt(c.errors.chat_reserved, { time: at }) : c.errors.chat_reserved_plain;
    }
    // More turns than the film's own bound (0232): its length changed while the plan was being set up. Check again re-reads it.
    if (e === "plan_too_long") return c.errors.plan_too_long;
    if (e === "chat_plan_required") return c.planLocked;
    if (e === "message_too_long") return fmt(c.errors.message_too_long, { max: load.state === "ready" ? load.plan.max_input_chars : 2000 });
    if (e === "short_not_available") return c.shortNotAvailable;
    if (e === "channel_required") return c.errors.channel_required;
    if (e === "content_refused") return c.errors.content_refused;
    if (e === "output_too_long") return c.errors.output_too_long;
    if (e === "brief_too_large") return c.errors.brief_too_large;
    if (e === "nothing_to_choose") return c.errors.nothing_to_choose;
    if (e === "film_refused") return c.errors.film_refused;
    if (e === "not_enabled") return c.errors.not_enabled;
    // Support is a link either way (actionFor): the address, or the site's contact block when none is configured.
    if (e === "adult_only_service") return c.errors.adult_only_service;
    if (e === "adult_attestation_required") return c.errors.adult_attestation_required;
    if (e === "session_closed") return c.errors.session_closed;
    if (e === "not_a_member") return c.errors.not_a_member;
    if (e === "card_changed") return c.errors.card_changed;
    // A film editor's storyboard conversation opened here (a link, the history): its own words and a link to that project.
    if (e === "film_conversation") return c.errors.film_conversation;
    // The gate's other refusals are worded by their REMEDY, the same words as before a press.
    const remedy = gateRemedy(e);
    if (remedy) return gateWords(remedy);
    // Which chapter failed is the server's count, not the model's words; nothing was priced either way.
    const step = d.step && typeof d.step === "object" ? (d.step as { chapter?: unknown; chapters?: unknown }) : null;
    const at = step && typeof step.chapter === "number" && typeof step.chapters === "number" ? { n: step.chapter, total: step.chapters } : null;
    // The turns this press used are the server's count; never a "nothing was charged" after turns were spent (Lens M1).
    if (e === "story_arc_invalid") return fmt(c.errors.story_arc_invalid, { messages: pluralText(c.messageCount, typeof d.used === "number" ? d.used : 1, locale) });
    if (e === "speech_not_available") return c.errors.speech_not_available;
    if (e === "plan_failed" && d.reason === "speech_not_available") return c.errors.speech_not_available;
    if (e === "looks_too_long") {
      return typeof d.length === "number" && typeof d.limit === "number" && typeof d.in_frame === "number"
        ? fmt(c.errors.looks_too_long, { n: d.in_frame, length: d.length, limit: d.limit }) : c.errors.looks_too_long_plain;
    }
    // Its own words on every path, the lease's read-back included (plan_failed with the reason): never the generic failure (Pixel M4).
    if (e === "narration_too_long" || (e === "plan_failed" && d.reason === "narration_too_long")) {
      const chapter = typeof d.chapter === "number" ? d.chapter : at?.n;
      return typeof chapter === "number" ? fmt(c.errors.narration_too_long, { chapter }) : c.errors.narration_too_long_plain;
    }
    if (e === "plan_failed" && d.reason === "shot_rules") return c.errors.plan_shot_rules;
    if (e === "plan_failed") return at ? fmt(c.errors.plan_failed, at) : c.errors.plan_failed_plain;
    if (e === "plan_length_mismatch") return at ? fmt(c.errors.plan_length_mismatch, at) : c.errors.plan_length_mismatch_plain;
    if (e === "plan_over_cap" && typeof d.needed === "number" && typeof d.left === "number") {
      // Each count with its own plural (Probe M3: "1 are left").
      const words = fmt(c.errors.plan_over_cap, { needed: pluralText(c.messageCount, d.needed, locale), left: pluralText(c.messagesLeft, d.left, locale) });
      // The Free trial has no "tomorrow": its remedy is a plan, said in its own words.
      if (d.scope === "trial") {
        return fmt(c.errors.plan_over_cap_trial, { needed: pluralText(c.messageCount, d.needed, locale), left: pluralText(c.messagesLeft, d.left, locale) });
      }
      return d.scope === "person" ? `${words} ${c.errors.plan_over_cap_person}` : words;
    }
    // 0211's lease and the plan's own refusals, each in its own words (a tab waiting, an older proposal, an edit that won).
    if (e === "plan_running") return c.errors.plan_running;
    if (e === "plan_unavailable") return c.errors.plan_unavailable;
    if (e === "plan_superseded") return c.errors.plan_superseded;
    if (e === "proposal_outdated") return c.errors.proposal_outdated;
    // A scene the film's models cannot take whole (S9, 0218): its number and the limit as the server measured them, never cut.
    if (e === "prompt_too_long" && typeof d.limit === "number") {
      if (typeof d.chapter === "number") return fmt(c.errors.prompt_too_long_chapter, { chapter: d.chapter, limit: d.limit });
      if (typeof d.scene === "number") return fmt(c.errors.prompt_too_long, { scene: d.scene, limit: d.limit });
    }
    // The model is the owner's choice and hidden from customers: any model failure reads as "unavailable right now".
    if (e === "model_failed" || e === "model_unavailable" || e === "model_answer_invalid") return c.errors.assistant_unavailable;
    return c.errors.unavailable;
  };

  /** Where a refusal is fixed, when that is a place in the app (or the support address) rather than another press. */
  const actionFor = (e: string, d?: Record<string, unknown>): NonNullable<Problem>["action"] => {
    const plans = `/${encodeURIComponent(channelSlug)}/credits#plans`;
    if (e === "chat_plan_required") return { href: plans, label: c.upgrade };
    if (e === "chat_daily_cap") return { href: plans, label: c.seePlans };
    // The 18+ question is asked once, on Create (AgeGate, 0192); an "under 18" answer is not changed in the app: support is.
    if (e === "adult_attestation_required") return { href: `/${encodeURIComponent(channelSlug)}/create`, label: c.confirmAge };
    if (e === "adult_only_service") return { href: LEGAL.contactEmail ? `mailto:${LEGAL.contactEmail}` : CONTACT_HREF, label: t.age.contact };
    // The plan needs more of today's messages than are left: a larger plan has more (Pixel minor). Not when the cap is the person's
    // own (0199's per_user_daily, one global setting): no plan raises it, so a "See plans" key would name a remedy that is not one
    // (Lens round 3). The words say to wait instead.
    if (e === "plan_over_cap") return d?.scope === "person" ? null : { href: plans, label: c.seePlans };
    if (e === "film_conversation" && typeof d?.film_id === "string" && UUID_RE.test(d.film_id)) return { href: editorHref(d.film_id), label: c.openFilm };
    return null;
  };

  /** #900's refusal block: the words, a Retry when one can help, and the link to where the fix is made. */
  const problemBlock = (p: NonNullable<Problem>, bare = false): ReactNode => (
    <div className={bare ? "ns-ai-problem ns-ai-problem--bare" : "ns-ai-problem"} role="alert" data-problem={p.code || undefined}>
      <p className="m-0 flex items-start gap-2">
        <TriangleAlert aria-hidden size={16} className="ns-ai-problem-ic" />
        <span>{p.text}</span>
      </p>
      {(p.retry || p.action) && (
        <div className="flex flex-wrap gap-2">
          {p.retry && <button type="button" className="btn-quiet min-h-11 px-3 text-sm" onClick={p.retry} disabled={busy}>{p.retryLabel ?? c.retry}</button>}
          {p.action &&
            (p.action.href.startsWith("mailto:") ? (
              <a className="btn-quiet inline-flex min-h-11 items-center px-3 text-sm" href={p.action.href}>{p.action.label}</a>
            ) : (
              <Link className="btn-quiet inline-flex min-h-11 items-center px-3 text-sm" href={p.action.href}>{p.action.label}</Link>
            ))}
        </div>
      )}
    </div>
  );

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/brain/turn", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (d.quota && typeof d.quota === "object") {
      const q = d.quota as { used: number; limit: number | null; trial_left?: number | null; reserved?: unknown };
      // A turn's own answer says what is held now (0232); without it, what the panel last read stays.
      setLoad((cur) => (cur.state === "ready" ? { ...cur, plan: { ...cur.plan, used: q.used, limit: q.limit, trial_left: q.trial_left ?? null,
        ...(typeof q.reserved === "number" ? { reserved: Math.max(0, q.reserved) } : {}) } } : cur));
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
        const r = sid ? await loadSession(sid) : null;
        if (!sid || !r || r.ok) {
          setAsking(null);
          return true;
        }
        // Stored, but it could not be shown: the words stay (in the box and under the thread) until the conversation opens, and the
        // Retry reads it again rather than sending them twice.
        if (r.gone) {
          forget(sid);
          setReloadKey((k) => k + 1);
        }
        setProblem({ text: r.message, retry: r.retry ? () => void reopen.current(sid) : null });
        return false;
      }
      // A chat the server just created is listed straight away.
      const isNew = !!sid && sid !== sessionRef.current;
      if (isNew) {
        setSession(sid);
        setReloadKey((k) => k + 1);
      }
      if (!res.ok) {
        if (d.error === "chat_daily_cap") setCapped(true);
        // The model's gate refused this turn: the box closes as it would have before the press (Pixel minor).
        const refusedBy = d.error;
        // A "retry" remedy (age_unavailable: the attestation could not be read) is not a closed gate: its Retry must find the box
        // open once it succeeds, and nothing here would reopen it (Lens round 3).
        if (isChatGateError(refusedBy) && CHAT_GATE_REMEDY[refusedBy] !== "retry") {
          setLoad((cur) => (cur.state === "ready" ? { ...cur, gate: { code: refusedBy, remedy: CHAT_GATE_REMEDY[refusedBy] } } : cur));
        }
        const retryable = res.status !== 401 && !NO_RETRY.includes(String(d.error));
        // A turn that was taken (the server reports its quota) already stored the message: retry it as it is, never a second copy.
        // One that was not is sent again with the same press id: a press that did land is answered as a duplicate.
        const taken = !!d.quota && !!sid;
        setProblem({
          text: explain(res.status, d),
          // A project's conversation is said in words only: its code is never put on the page, not even as a data attribute.
          code: d.error === "film_conversation" ? "" : String(d.error ?? ""),
          retry: retryable ? (taken ? () => void run(label, { action: "retry", session: sid }) : () => void run(label, body)) : null,
          action: actionFor(String(d.error), d),
        });
        return false;
      }
      if (d.reply && sid) {
        setStep(String(d.step ?? "asking"));
        setCard((d.card as BrainCard | null) ?? null);
        if (d.slots && typeof d.slots === "object") setSlots(readSlots(d.slots));
        setChanging(null);
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
      // A card's option that was pressed is gone with the card: focus goes back to the box, not to <body> (Pixel P5).
      setTimeout(refocus, 0);
    }
  };

  const answer = (choice: number | null, ownWords = ""): Promise<boolean> => {
    if (!card || !session) return Promise.resolve(false);
    const label = choice ? card.options[choice - 1] : ownWords.trim();
    if (!label) return Promise.resolve(false);
    return run(label, { action: "answer", session, card: card.id, request_id: pressId(), ...(choice ? { choice } : { own: label }) });
  };
  /** A chip's change: one of the server's own options, or (the audience) the person's own words. A turn like any answer. */
  const change = async (slot: InferableSlot, choice: number | null, ownWords = ""): Promise<boolean> => {
    if (!session) return false;
    const value = choice ? changeOptions(slot)[choice - 1] : ownWords.trim();
    if (!value) return false;
    const ok = await run(`${c.slotNames[slot]}: ${optionLabel(slot, value)}`, { action: "change", session, slot, request_id: pressId(), ...(choice ? { choice } : { own: value }) });
    // A change that failed closes its card: the refusal below says why, and the chip still shows the value that stands (Pixel m7).
    if (!ok) closeChange(false);
    return ok;
  };
  const send = (raw: string): Promise<boolean> => {
    const words = raw.trim();
    if (!words || capped) return Promise.resolve(false);
    // The box answers an open chip only when that slot takes free text (the audience). For a shape or a language, a typed message is
    // an ordinary turn, and the card closes (Pixel M2: "make it funnier" was sent as the shape).
    if (changing === "audience" && session) return change(changing, null, words);
    if (changing) closeChange(false);
    // While a question card is open the box is its "own answer" (the card's options are buttons above it).
    if (card && step === "asking" && session) return answer(null, words);
    const request_id = pressId();
    return run(words, session ? { action: "turn", session, text: words, request_id } : { action: "start", channel: channelId, prompt: words, request_id });
  };
  /**
   * Wait for a plan this tab did not see finish (a refresh mid-plan, another tab, a repeated press), never start a second one. It
   * ends when 0211's lease says so (Lens M1): done → the conversation is read again (the storyboard and its price); failed → said at
   * once with its reason; still running at its end → failed. `until` is the lease's own end when it is known.
   */
  const waitForPlan = async (sid: string, w: { title: string; index: number; until: number; other?: boolean }, signal: AbortSignal) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setPlanning(true);
    setPlanOther(!!w.other);
    setProblem(null);
    setAsking(w.title);
    let failed: string | null = null;
    try {
      while (Date.now() < w.until) {
        await new Promise((r) => setTimeout(r, 5_000));
        if (signal.aborted || sessionRef.current !== sid) return;
        const r = await historyCall(historyUrl(`session=${encodeURIComponent(sid)}`),
          (b) => b as { session?: { step?: string }; brief?: Brief | null; plan?: PlanLease | null });
        if (signal.aborted) return;
        const lease = r.ok ? readLease(r.value.plan) : null;
        const b = r.ok ? r.value.brief : null;
        if (lease?.state === "failed") {
          failed = lease.reason ?? "unavailable";
          break;
        }
        if (lease?.state === "done" || (r.ok && r.value.session?.step === "ready" && b?.version === 1 && b.title === w.title && b.scenes?.length)) {
          keepPlan(sid, null);
          setAsking(null);
          await loadSession(sid);
          return;
        }
      }
      if (signal.aborted) return;
      // Failed, or the route's time is over and nothing was stored: a new press is safe now.
      keepPlan(sid, null);
      const reason = failed ?? "expired";
      setProblem({ text: explain(502, { error: "plan_failed", reason }), code: "plan_failed",
                   retry: NO_RETRY_REASONS.has(reason) ? null : () => void chooseRef.current(w.index) });
    } finally {
      inFlight.current = false;
      if (!signal.aborted) {
        setPlanning(false);
        setBusy(false);
      }
    }
  };
  const waitRef = useRef(waitForPlan);
  const chooseRef = useRef<(index: number, rid?: string) => Promise<void>>(async () => {});
  // A plan to follow on this conversation: this tab's own press (sessionStorage), or the database's lease (another tab, a refresh).
  useEffect(() => {
    waitRef.current = waitForPlan;
  });
  useEffect(() => {
    if (!session || typeof window === "undefined") return;
    const ctl = new AbortController();
    const outlines = [...messages].reverse().find((m) => m.role === "assistant")?.scenarios ?? [];
    const p = pendingPlan(session);
    if (p && Date.now() - p.at < PLAN_WAIT_MS) {
      void waitRef.current(session, { title: p.title, index: p.index, until: p.at + PLAN_WAIT_MS }, ctl.signal);
    } else {
      if (p) keepPlan(session, null);
      if (lease?.state === "running" && lease.until > Date.now()) {
        const index = lease.index ?? 0;
        void waitRef.current(session, { title: outlines[index]?.title ?? "", index, until: lease.until, other: true }, ctl.signal);
      } else if (lease?.state === "failed" && step === "proposing" && !inFlight.current
                 // Only for the proposal on screen: an older one's failure is not news once new scenarios were asked for.
                 && (lease.proposal === null || [...messages].reverse().find((m) => m.role === "assistant")?.key === `m${lease.proposal}`)) {
        // A plan that failed while this tab was not looking: said at once, with its reason, never a silent empty choice.
        const reason = lease.reason ?? "unavailable";
        setProblem({ text: explain(502, { error: "plan_failed", reason }), code: "plan_failed",
                     retry: NO_RETRY_REASONS.has(reason) ? null : () => void chooseRef.current(lease.index ?? 0) });
      }
    }
    return () => ctl.abort();
    // Only a new conversation or a new lease reading starts (or stops) a wait; a message added meanwhile does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, lease]);

  // `rid` is kept only when the last press's answer never arrived (the network): the server answers its repeat as a duplicate.
  const choose = async (index: number, rid: string = pressId()) => {
    if (!session || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    const outline = [...messages].reverse().find((m) => m.role === "assistant")?.scenarios?.[index];
    // Only a short outline with no storyboard yet is written now (lib/server/brain/plan.ts); anything else answers at once.
    const writes = brief?.kind !== "long" && !!outline && !outline.scenes?.length;
    if (writes && outline) {
      setPlanning(true);
      // The server stores this choice as the person's message: it is drawn as theirs while the storyboard is written.
      setAsking(outline.title);
      keepPlan(session, { rid, index, title: outline.title, at: Date.now() });
    }
    let waiting: { title: string; index: number; until: number; other?: boolean } | null = null;
    try {
      const { res, d } = await post({ action: "choose", session, index, request_id: rid });
      // Another copy of this choice is being written (this press again, another tab: 0211's plan_running): wait for it, spend
      // nothing more.
      if (res.status === 409 && (d.error === "duplicate_request" || d.error === "plan_running")) {
        const until = typeof d.expires_at === "string" ? Date.parse(d.expires_at) : NaN;
        const p = pendingPlan(session);
        waiting = Number.isFinite(until) ? { title: outline?.title ?? "", index, until, other: d.error === "plan_running" }
          : p ? { title: p.title, index: p.index, until: p.at + PLAN_WAIT_MS } : null;
        if (!waiting) await loadSession(session);
        return;
      }
      keepPlan(session, null);
      if (!res.ok) {
        // A failed plan's calls were recorded under this press's ids: a Retry is a new press (a new id), never refused as a repeat.
        // A failure no new attempt can change (the outline cannot fit, the model is not set up here) offers none (Lens L7).
        const noRetry = res.status === 401 || NO_RETRY.includes(String(d.error)) || (d.error === "plan_failed" && NO_RETRY_REASONS.has(String(d.reason)));
        const checkAgain = d.error === "plan_unavailable";
        setProblem({ text: explain(res.status, d), code: d.error === "film_conversation" ? "" : String(d.error ?? ""),
                     retry: checkAgain ? () => void choose(index) : noRetry ? null : () => void choose(index),
                     retryLabel: checkAgain ? c.checkAgain : undefined,
                     action: d.error === "plan_superseded" && typeof d.film_id === "string"
                       ? { href: editorHref(d.film_id), label: c.openProject } : actionFor(String(d.error), d) });
        return;
      }
      setAsking(null);
      setStep("ready");
      setFilm(d.film ? { id: (d.film as { id: string }).id, quote: coerceQuote(d.film_quote), index } : null);
      setModels(readModels(d.models));
      announce(session, d.brief as Brief);
    } catch {
      setProblem({ text: c.errors.unavailable, retry: () => void choose(index, rid) });
    } finally {
      inFlight.current = false;
      setPlanning(false);
      setBusy(false);
      setTimeout(refocus, 0);
      if (waiting && life.current) void waitForPlan(session, waiting, life.current.signal);
    }
  };
  useEffect(() => {
    chooseRef.current = choose;
  });
  /** A start went through (S2's button): the conversation records which film it became, once, and the live view opens. A replay
   *  (this press already counted) is the same start: recorded once all the same. */
  const filmStarted = async (filmId: string) => {
    if (session && handedOff.current !== filmId) {
      handedOff.current = filmId;
      await post({ action: "handoff", session, handoff: { kind: "film", film_id: filmId } }).catch(() => undefined);
    }
    window.location.assign(liveHref(filmId));
  };
  const liveHref = (filmId: string) => `/${encodeURIComponent(channelSlug)}/studio?view=live&film=${encodeURIComponent(filmId)}`;
  /** The film's project editor (/{channel}/create/projects/{id}), where a model is set or a storyboard edited: S2's Create links
   *  there for every refusal the person fixes in the project (fixHref), and plan_superseded opens it. */
  const editorHref = (filmId: string) => `/${encodeURIComponent(channelSlug)}/create/projects/${encodeURIComponent(filmId)}`;
  const newChat = () => {
    clear();
    if (typeof window === "undefined") return;
    const u = new URL(window.location.href);
    if (!u.searchParams.has("brain")) return;
    // The same path as forget(): the canvas draws ?brain= from the page's props, so a history.replaceState left it drawing the old
    // conversation beside the new chat (#900's leftover). A replace, so Back does not return to it; the re-read it causes is skipped.
    u.searchParams.delete("brain");
    if (initialSession) dropped.current = true;
    routerRef.current.replace(`${u.pathname}${u.search}${u.hash}`, { scroll: false });
  };

  const source = useMemo<ChatHistorySource>(
    () => ({
      // A list that failed says so in the list's words ("Couldn't load your chats"), never as a chat that would not open.
      list: (before) =>
        historyCall(
          historyUrl(before ? `before=${encodeURIComponent(before)}` : ""),
          (b) => ({
            items: (Array.isArray(b.sessions) ? (b.sessions as { id: string; title: string; updated_at: string }[]) : []).map((r) => ({
              id: r.id,
              title: r.title,
              updatedAt: r.updated_at,
            })),
            nextBefore: typeof b.next_before === "string" ? b.next_before : null,
          }),
          c.history.error,
        ),
    }),
    [historyCall, historyUrl, c],
  );

  async function openSession(id: string): Promise<HistoryResult<null>> {
    // An answer on its way belongs to the chat on screen: the pick is refused and said, never taken as opened.
    if (inFlight.current) return { ok: false, message: c.history.busy };
    setOpening(true);
    const r = await loadSession(id);
    setOpening(false);
    if (!r.ok) {
      // The chat on screen is no longer this person's here: the next message must not try to continue it.
      if (r.gone) forget(id);
      return r;
    }
    setProblem(null);
    setAsking(null);
    announce(id, null);
    return r;
  }

  // On a phone the canvas's dock and the keyboard cover the bottom of the screen: the box and Send are brought into view when the
  // box takes focus, and again once the keyboard has resized the viewport (Pixel on #900, 390x500 with the keyboard up). The room
  // kept under them is the composer's scroll-margin (nightshift-ai-panel.css), so "nearest" stops above the dock, not under it.
  const watch = useRef<(() => void) | null>(null);
  const revealComposer = (e: FocusEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.id !== INPUT_ID) return;
    const composer = target.closest<HTMLElement>(".chat-composer");
    const reveal = () => composer?.scrollIntoView?.({ block: "nearest" });
    reveal();
    const vv = typeof window === "undefined" ? null : window.visualViewport;
    if (!vv || watch.current) return;
    vv.addEventListener("resize", reveal);
    watch.current = () => vv.removeEventListener("resize", reveal);
  };
  const hideComposerWatch = (e: FocusEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).id !== INPUT_ID) return;
    watch.current?.();
    watch.current = null;
  };
  useEffect(() => () => watch.current?.(), []);

  if (load.state === "hidden") return null;
  const lengthLabel = (s: number) => (s >= 60 ? fmt(c.minutes, { n: Math.round((s / 60) * 10) / 10 }) : fmt(c.seconds, { n: s }));
  const ready = load.state === "ready";
  // No Brain on this plan: the lifetime trial while it lasts, then the upgrade.
  const trial = ready && load.plan.limit === null && (load.plan.trial_left ?? 0) > 0 ? load.plan.trial_left : null;
  // A plan whose price could not be read, or a short plan with no film on screen (a reload): its scenarios come back to choose
  // again. That replays the same draft (its key is the session, proposal and outline) and prices it as it is now; a draft that has
  // scenes is never written over (the route, Lens H1).
  const rechoose = step === "ready" && (brief?.price?.state === "failed" || (brief?.kind === "short" && !film));
  const noBrain = ready && load.plan.limit === null && trial === null;
  const down = ready && load.model !== "available";
  const viewer = ready && !load.canEdit;
  const closed = step === "created";
  // The box cannot be used at all: the status above it says why and what to do.
  // The model's gate said before any press that this person cannot use it (#898 GET /api/brain `gate`): the box, the card's answers
  // and choosing are closed up front, with the remedy, instead of a press that could only be refused.
  const gated = ready ? load.gate : null;
  const blocked = !ready || capped || noBrain || down || viewer || closed || !!gated;
  const disabled = busy || blocked;
  const plansHref = `/${encodeURIComponent(channelSlug)}/credits#plans`;
  const maxChars = ready ? load.plan.max_input_chars : 2000;

  const status: ReactNode = (() => {
    if (load.state === "loading") return <p role="status" aria-busy="true">{c.loading}</p>;
    if (load.state === "failed")
      return (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p>{c.errors.unavailable}</p>
          <button type="button" className="btn-quiet min-h-11 px-3 text-sm" onClick={() => void read()}>{c.retry}</button>
        </div>
      );
    // "Check back later": the press that checks is here, a fresh read of the same state (nothing is sent or spent).
    if (load.state === "not_enabled") return <StatusWithAction text={c.errors.not_enabled} label={c.checkAgain} onPress={() => void read()} />;
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
    // The cap is a rolling 24 hours and the server reports no reset time, so none is shown; a larger plan has a larger cap.
    if (capped && !problem)
      return (
        <div role="status" className="flex flex-col gap-2">
          <p>{load.plan.limit !== null ? fmt(c.errors.chat_daily_cap, { used: load.plan.used ?? load.plan.limit, limit: load.plan.limit }) : c.errors.chat_daily_cap_plain}</p>
          <Link className="btn-quiet inline-flex min-h-11 items-center justify-center self-start px-4 text-sm" href={plansHref}>{c.seePlans}</Link>
        </div>
      );
    if (down) return <StatusWithAction text={c.errors.assistant_unavailable} label={c.checkAgain} onPress={() => void read()} />;
    if (viewer) return <p role="status">{c.viewerOnly}</p>;
    if (closed) return <p role="status">{c.errors.session_closed}</p>;
    // A retry here asks the gate again (GET /api/brain): it reads the answer anew, and spends nothing.
    // An age answer (0192) before a press reads exactly as the same refusal after one: #900's words and link, no Retry.
    if (gated && !problem && AGE_CODES.has(gated.code))
      return problemBlock({ text: explain(403, { error: gated.code }), retry: null, code: gated.code, action: actionFor(gated.code) }, true);
    if (gated && !problem) {
      const r = gateRemedy(gated.code);
      return r ? gateBlock(r, gated.code, () => void read()) : null;
    }
    return null;
  })();

  // What storyboards being written hold (0232), shown as held, never as used; never more than what was left to hold.
  const heldRaw = ready ? Math.max(0, load.plan.reserved ?? 0) : 0;
  const held = ready && load.plan.limit !== null && load.plan.used !== null ? Math.min(heldRaw, Math.max(0, load.plan.limit - load.plan.used)) : heldRaw;
  const heldUntil = ready ? clockOf(load.plan.reserved_until) : null;
  const meter: ReactNode = ready && ((load.plan.limit !== null && load.plan.used !== null) || trial !== null) ? (
    <p className="chat-meter" data-capped={load.plan.limit !== null && load.plan.used !== null && load.plan.used + held >= load.plan.limit ? "" : undefined}>
      {load.plan.limit !== null && load.plan.used !== null && (held > 0
        ? fmt(heldUntil ? c.quotaReserved : c.quotaReservedPlain, { used: load.plan.used, limit: load.plan.limit, reserved: held, time: heldUntil ?? "" })
        : fmt(c.quota, { used: load.plan.used, limit: load.plan.limit }))}
      {trial !== null && (
        <>
          {pluralText(c.trialLeft, Math.max(0, trial - heldRaw), locale)}{" "}
          <Link className="chat-meter-link" href={plansHref}>{c.upgrade}</Link>
        </>
      )}
    </p>
  ) : null;

  const paired = pairTurns(messages, c.history.noAnswer);
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant") ?? null;
  // The newest ANSWER's outlines, even with the person's choice stored after it (the plan step's first turn): a failed plan must
  // still offer them again, after a reload too.
  const isLast = (m: Msg | null) => !!m && m === lastAssistant;

  // Under the newest answer: its question card, or the plan with its price and its one way on.
  const inferred = (slots.inferred ?? []).filter(isInferable).filter((k) => slots[k] !== undefined);
  const chipValue = (k: InferableSlot) => (k === "language" ? optionLabel(k, String(slots[k] ?? "")) : String(slots[k] ?? ""));
  const tail: ReactNode = (
    <>
      {inferred.length > 0 && step !== "ready" && step !== "created" && (
        <div className="flex flex-wrap items-center gap-2" data-testid="inferred-chips">
          <span className="text-xs text-[var(--color-muted)]">{c.inferredHeading}</span>
          {inferred.map((k) => (
            <Fragment key={k}>
              <button ref={(el) => { chipRefs.current[k] = el; }} type="button" className="btn-quiet inline-flex min-h-11 items-center gap-1 px-3 text-xs"
                data-slot={k} disabled={disabled} aria-expanded={changing === k} aria-controls={changing === k ? CHANGE_CARD_ID : undefined}
                aria-label={fmt(c.inferredChipLabel, { slot: c.slotNames[k], value: chipValue(k) })}
                onClick={() => (changing === k ? closeChange(true) : setChanging(k))}>
                {fmt(c.inferredChip, { slot: c.slotNames[k], value: chipValue(k) })}
                <Pencil aria-hidden size={12} />
              </button>
              {/* Right after the chip that opened it (Pixel M1): Tab from the chip reaches the card, not the next chip. */}
              {changing === k && (
                <fieldset id={CHANGE_CARD_ID} ref={changeCardRef} className="studio-field flex w-full min-w-0 flex-col gap-2 p-3" disabled={disabled}
                  data-testid="change-card" onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); closeChange(true); } }}>
                  <legend className="text-sm font-semibold">{fmt(c.changeQuestion, { slot: c.slotNames[k] })}</legend>
                  {changeOptions(k).map((o, i) => (
                    <button key={o} type="button" className="btn-quiet flex min-h-11 items-center !justify-start gap-2 px-3 text-left text-sm" onClick={() => void change(k, i + 1)}>
                      <span className="font-semibold">{i + 1}</span> <span className="break-words">{optionLabel(k, o)}</span>
                    </button>
                  ))}
                  {changeOptions(k).length === 0 && <p className="text-xs text-[var(--color-muted)]">{fmt(c.changeOwn, { slot: c.slotNames[k].toLowerCase() })}</p>}
                  <button type="button" className="btn-quiet min-h-11 self-start px-3 text-sm" onClick={() => closeChange(true)}>{c.changeCancel}</button>
                </fieldset>
              )}
            </Fragment>
          ))}
        </div>
      )}
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
      {step === "ready" && brief && (
        <ReadyBlock brief={brief} film={film} models={models} channelSlug={channelSlug} lengthLabel={lengthLabel} canRun={ready && load.canRun}
          fixHref={film ? editorHref(film.id) : undefined} onWordless={busy ? undefined : () => void send(c.wordlessAskText)}
          sheets={brief.kind === "short" && film && session && (brief.characters?.length ?? 0) > 0 ? (
            // Character sheets (lib/brain/ref-sheets): their own route and their own confirm; attaching them re-prices the film,
            // and the Create below is remounted with that quote.
            <RefSheetsPanel key={`${session}:${film.id}:${charactersKey(brief)}`} brief={brief} sessionId={session} filmId={film.id} channelSlug={channelSlug}
              onFilmQuote={(q, version) => setFilm((f) => (f && f.id === film.id ? { ...f, quote: coerceQuote(q), version } : f))} />
          ) : null}
          create={brief.kind === "short" && film ? (
            // No `requote`: S2's own requoteFilm prices the film's CURRENT version and writes nothing (Lens H1). No
            // `onChooseAnother`: choosing again here would draft the same models again (Lens M1); S2 offers support instead.
            <FilmCreateButton key={`${film.id}:${film.version ?? 0}`} filmId={film.id} quote={film.quote} onStarted={() => void filmStarted(film.id)}
              progressHref={liveHref(film.id)} fixHref={editorHref(film.id)} />
          ) : null} />
      )}
    </>
  );
  // The chips of what was guessed stay under the newest answer until a plan is chosen, with or without a card.
  const hasTail = (card && step === "asking") || (step === "ready" && brief) || (inferred.length > 0 && step !== "ready" && step !== "created");

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
              {s.scenes?.length
                ? fmt(c.scenarioFacts, { len: lengthLabel(s.target_seconds), scenes: s.scenes.length, characters: s.characters?.length ?? 0 })
                : fmt(c.outlineFacts, { len: lengthLabel(s.target_seconds), chapters: s.chapters?.length ?? 0, characters: s.characters?.length ?? 0 })}
            </p>
            {/* What choosing it costs in today's messages, said before the press (the server's count, "about": a chapter asked again
                is one more). No count, no line: never a guessed number. */}
            {s.plan_turns && ready && (
              <p className="text-xs text-[var(--color-muted)]" data-plan-turns={s.plan_turns.about}>
                {load.plan.limit !== null && load.plan.used !== null
                  ? fmt(c.planCost, { about: s.plan_turns.about, at_most: s.plan_turns.at_most, limit: load.plan.limit,
                                      left: pluralText(c.messagesLeft, Math.max(0, load.plan.limit - load.plan.used - heldRaw), locale) })
                  : load.plan.limit === null && load.plan.trial_left !== null
                    ? fmt(c.planCostTrial, { about: s.plan_turns.about, at_most: s.plan_turns.at_most, left: Math.max(0, load.plan.trial_left - heldRaw) })
                    // What is left today could not be read: the cost alone, never a "left" made up.
                    : fmt(c.planCostPlain, { about: s.plan_turns.about, at_most: s.plan_turns.at_most })}
              </p>
            )}
            <button type="button" className="btn-quiet mt-1 min-h-11 px-4 text-sm" disabled={disabled} aria-label={fmt(c.chooseThisNamed, { title: s.title })} onClick={() => void choose(k)}>{c.chooseThis}</button>
          </article>
        ))}
        {last && hasTail && tail}
      </>
    ) : undefined;
    return { id: idFor(p.key), q: p.q, a: p.a, extra };
  });

  const notice: ReactNode = problem || planning || (hasTail && turns.length === 0) ? (
    <>
      {hasTail && turns.length === 0 && tail}
      {planning && <p className="chat-note" role="status">{planOther ? c.errors.plan_running : c.planWriting}</p>}
      {/* After a press: the same block as before one (gateBlock). No ProviderUnavailable: its words name a provider and offer
          another model. */}
      {problem && gateRemedy(problem.code) && gateBlock(gateRemedy(problem.code)!, String(problem.code), problem.retry)}
      {problem && !gateRemedy(problem.code) && problemBlock(problem)}
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
        placeholder: (card && step === "asking") || changing === "audience" ? c.shell.ownAnswer : c.shell.placeholder,
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
    <div className="ns-ai-dock" data-testid="nightshift-ai-panel" onFocus={revealComposer} onBlur={hideComposerWatch}>
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
          // The drawer closes on a pick: its refusal is said here, in the chat, not inside the closed drawer (#900's leftover).
          onPickMessage={(text) => setProblem({ text, retry: null })}
        />
      ) : load.state === "loading" ? (
        // The history's menu button arrives with the ready state: its place is kept, so the title does not jump sideways.
        chat(<span className="chat-act ns-ai-lead-slot" aria-hidden />)
      ) : (
        chat()
      )}
    </div>
  );
}

/** A state line with the one press that can change it. */
function StatusWithAction({ text, label, onPress }: { text: string; label: string; onPress: () => void }) {
  return (
    <div role="status" className="flex flex-col gap-2">
      <p>{text}</p>
      <button type="button" className="btn-quiet min-h-11 self-start px-4 text-sm" onClick={onPress}>{label}</button>
    </div>
  );
}

function ReadyBlock({ brief, film, models, channelSlug, lengthLabel, canRun, create, sheets, fixHref, onWordless }: {
  brief: Brief; film: FilmReady | null; models: FilmModels | null; channelSlug: string; lengthLabel: (s: number) => string; canRun: boolean;
  /** The film's editor, where its saved storyboard is, when Create is not offered. */
  fixHref?: string;
  /** Asks, as an ordinary turn, for a version of the story that can be made today (without spoken words). */
  onWordless?: () => void;
  /** S2's Create for a short film's draft; its own states say a short film's credits, blocks and refusals. */
  create: ReactNode;
  /** The character sheets of a short film's draft (RefSheetsPanel), shown above its Create. */
  sheets?: ReactNode;
}) {
  const { t, fmt, locale } = useI18n();
  const c = t.aiChat;
  const p = brief.price;
  const slots: BrainSlots = { kind: brief.kind ?? undefined };
  const speech = new Set((brief.scenes ?? []).map(speechOf));
  const meantWords = (brief.speech_intent !== undefined && brief.speech_intent !== "none")
    || (brief.scenes ?? []).some((s) => s.speech_intent !== undefined && s.speech_intent !== "none");
  // What stops this film at Create today, by name (lib/brain/logic speechBlocks): no Create is offered then, never a silent film.
  const blocked = brief.kind === "short" && film ? brief.voice?.blocked ?? [] : [];
  // The number printed the way every price in the app is (lib/credits formatCredits), with its own plural word.
  const credits = (n: number) => fmt(pluralForm(c.price, n, locale), { n: formatCredits(n, locale) });
  return (
    <section className="studio-field flex flex-col gap-2 p-3" aria-label={c.planReady}>
      <h3 className="text-sm font-semibold text-[var(--color-fg)]">{brief.title}</h3>
      <p className="text-sm">{brief.idea}</p>
      <p className="text-xs text-[var(--color-muted)]">{fmt(c.scenarioFacts, { len: lengthLabel(brief.target_seconds ?? 0), scenes: brief.scenes?.length ?? 0, characters: brief.characters?.length ?? 0 })}</p>
      {/* Planned wordless where the format meant words (speechAllowed today): said plainly, so the missing voice is no surprise. */}
      {brief.kind === "short" && meantWords && !speech.has("voice_over") && !speech.has("in_clip") && <p className="text-xs" data-note="planned-wordless">{c.plannedWordless}</p>}
      {brief.kind === "short" && speech.has("voice_over") && <p className="text-xs text-[var(--color-muted)]">{c.voiceOverNote}</p>}
      {brief.kind === "short" && speech.has("in_clip") && <p className="text-xs text-[var(--color-muted)]">{c.inClipNote}</p>}
      {brief.kind === "short" && !meantWords && (brief.scenes?.length ?? 0) > 0 && speech.size === 1 && speech.has("none") && <p className="text-xs text-[var(--color-muted)]">{c.wordlessNote}</p>}
      {(brief.text_layers?.length ?? 0) > 0 && <p className="text-xs text-[var(--color-muted)]">{pluralText(c.textLayersNote, brief.text_layers!.length, locale)}</p>}
      {/* What the film is made with, as the server chose it (lib/brain/film-models): said, never hidden behind the price. A role
          with no model on sale shows no line; the quote's own "choose a model" says what to do. */}
      {brief.kind === "short" && film && models?.clip && <p className="text-xs" data-model="clip">{fmt(c.modelVideo, { name: models.clip.name })}</p>}
      {brief.kind === "short" && film && models?.keyframe && <p className="text-xs" data-model="keyframe">{fmt(c.modelPictures, { name: models.keyframe.name })}</p>}
      {/* A short film that has a draft is priced by S2's Create alone (Pixel P3): one price on the card, never two. */}
      {!(brief.kind === "short" && film) && (
        <>
          <p className="text-sm font-semibold">
            {p?.state === "priced" && credits(p.total_credits)}
            {p?.state === "exempt" && c.priceExempt}
            {p?.state === "unpriced" && c.priceUnpriced}
            {p?.state === "failed" && c.priceFailed}
            {!p && c.priceUnpriced}
          </p>
          {p?.state === "priced" && p.spendable === "unknown" && <p className="text-xs">{c.balanceUnknown}</p>}
        </>
      )}
      {/* A short film's credits are said by S2's Create below (its InsufficientCredits), never twice. */}
      {p?.state === "priced" && !p.fits && typeof p.spendable === "number" && slots.kind === "long" && (
        <div className="flex flex-col gap-2" role="note">
          <p className="text-sm">{fmt(c.insufficient, { len: lengthLabel(brief.target_seconds ?? 0), need: formatCredits(p.total_credits, locale), have: formatCredits(p.spendable, locale) })}</p>
          {p.shorter && (
            <Link className="btn-quiet inline-flex min-h-11 items-center px-4 text-sm" href={runLink(channelSlug, { ...brief, target_seconds: p.shorter.target_seconds })}>
              {fmt(c.useShorter, { len: lengthLabel(p.shorter.target_seconds), credits: formatCredits(p.shorter.credits, locale) })}
            </Link>
          )}
          {!p.shorter && <p className="text-sm">{c.noneFits}</p>}
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
      {brief.kind === "short" && !film && <p className="text-sm">{c.chooseAgain}</p>}
      {sheets}
      {/* A defence since the fix round: a speaking plan is no longer made (speechAllowed), so this shows only for a storyboard saved
          before it. No dead Create: the reasons, said once that nothing was priced, and the one press that can make it today. */}
      {blocked.length > 0 ? (
        <div className="flex flex-col gap-2" role="note" data-speech-blocked={blocked.join(" ")}>
          {blocked.map((b) => <p key={b} className="text-sm">{c.speechBlocked[b]}</p>)}
          <p className="text-sm">{c.blockedSaved}</p>
          <div className="flex flex-wrap gap-2">
            {onWordless && <button type="button" className="btn-primary min-h-11 px-4 text-sm" onClick={onWordless}>{c.wordlessAsk}</button>}
            {fixHref && <Link className="btn-quiet inline-flex min-h-11 items-center px-4 text-sm" href={fixHref}>{c.seeStoryboard}</Link>}
          </div>
        </div>
      ) : create}
    </section>
  );
}
