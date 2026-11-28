"use client";

import Link from "next/link";
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useChannelPath } from "@/lib/channels-client";
import { onBrainActivity, onBrainHandoff, type BrainActivity, type BrainHandoff } from "@/lib/studio/brainActivity";
import { adoptSession, enteringIds, initialView, parseViewMemory, VIEW_MEMORY_KEY, viewOnSend, type ColumnView, type ViewMemory } from "@/lib/studio/planBoard";
import { planItems } from "@/lib/studio/planGrid";
import { hasLitStep, type BoardInput } from "@/lib/studio/boardModel";
import { nsMarkOnce } from "@/lib/studio/nsMark";
import { CanvasActiveContext } from "@/components/studio-canvas/canvasActive";
import { BRAIN_BRIEF_EVENT, useBrainBrief } from "./useBrainBrief";
import { useBoardModel } from "./useBoardModel";
import { Details } from "./Details";
import { LiveLane } from "./LiveLane";
import { useLiveGraph, type LiveTarget } from "./useLiveGraph";
import { PlanBoard, PlanList, planCards } from "./PlanBoard";
import { ActivityPanel } from "./ActivityPanel";
import type { Activity } from "@/lib/studio/liveGraph";
import { SegTabs, tabPanelProps } from "./SegTabs";
import { reduced } from "./StoryBoard";
import { StudioSplitContext } from "./StudioSplit";
import "@/components/studio-canvas/studio-canvas.css";
import "./studio-live.css";

// The same shape as the panel's and page's checks (UUID, any version): a value from the URL is never read as an id otherwise.
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONE: ReadonlyMap<string, number> = new Map();
const PHONE = "(max-width: 767px)";
/** S5's stagger and reveal, as numbers, only to know when the entrance is over and the marks can go (the CSS reads the tokens). */
const STAGGER_MS = 40;
const REVEAL_MS = 480;
const STILL_WORKING_MS = 10_000;
/** The Plan column's own lane open/closed choice: folded by default on a short window, unlike the live page's. */
const PLAN_LANE_KEY = "ns.studio.plan.lane";
const FAILED_WORDS = new Set(["take_failed", "assembly_failed"]);

/**
 * The film's activity log under its lane, folded (Pixel's proposal: the board keeps its rows). The summary counts lines that arrived
 * since the person last looked; the first reading is not news. A failed step opens it, so a failure is never only behind a fold.
 */
function PlanActivity({ activity }: { activity: Activity }) {
  const { t } = useI18n();
  const w = t.studioLive.plan.activity;
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
  const ids = activity.items.map((i) => i.id);
  const key = ids.join("|");
  useEffect(() => {
    setSeen((s) => (s === null || open ? new Set(key ? key.split("|") : []) : s));
  }, [key, open]);
  const fresh = seen ? activity.items.filter((i) => !seen.has(i.id)) : [];
  const failedNew = fresh.some((i) => FAILED_WORDS.has(i.word));
  useEffect(() => {
    if (failedNew) setOpen(true);
  }, [failedNew]);
  return (
    <details className="plan-activity" open={open} onToggle={(e) => setOpen(e.currentTarget.open)} data-testid="plan-activity">
      <summary className="ds-t-body-sm plan-activity-summary">
        {w.label}
        <span aria-live="polite" data-testid="plan-activity-new">{fresh.length > 0 ? ` · ${fmt(w.fresh, { n: fresh.length })}` : ""}</span>
      </summary>
      <ActivityPanel activity={activity} run={false} />
    </details>
  );
}

function readMemory(): ViewMemory | null {
  try {
    return parseViewMemory(window.localStorage.getItem(VIEW_MEMORY_KEY));
  } catch {
    return null;
  }
}
function writeMemory(m: ViewMemory | null): void {
  if (!m) return;
  try {
    window.localStorage.setItem(VIEW_MEMORY_KEY, JSON.stringify(m));
  } catch {
    // Storage refused (private mode, full): the choice holds for this page only, which is all that is lost.
  }
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(PHONE);
    setPhone(m.matches);
    const on = () => setPhone(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return phone;
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const cardOf = (nodeId: string) => (/^scene#\d+:(keyframe|clip)$/.test(nodeId) ? nodeId.split(":")[0] : nodeId);

/**
 * The Studio's column beside Nightshift AI (docs/studio/S3_LIVE_MEASURE.md). Measured on main, the canvas there never changed during
 * a whole conversation. Now the column shows the plan as the conversation builds it, read once per finished turn (the panel's
 * `nightshift:brain-brief`, through useBrainBrief), and says when a turn or a storyboard is out (`nightshift:brain-activity`). No
 * polling timer and no new route.
 *
 * After Create the same board turns to the film in place (LIVE_CREATION_PLAN §3.9): the panel's `nightshift:brain-handoff`, the
 * page's `&film=` (a refresh), or the brief's own handoff (a refresh with only `?brain=`) names the film, and the cards light from its
 * live reading (useLiveGraph, the read-only `/api/films/{id}/live`), with the film's lane under them. The cards keep their ids
 * (position-keyed), so nothing remounts: the person sees the plan they confirmed start to be made. Measured before: a full reload,
 * 0.35 s with no page, then a page without this panel, and the first live card 1.2–1.5 s after confirm.
 *
 * Read-only (CLAUDE.md rule 3): the cards are DRAFT steps, then the film's steps as the database reports them; nothing here starts,
 * prices or spends. Create stays in the panel, the person's own confirmed act.
 *
 * The person's own canvas stays mounted while the plan is shown, hidden and inert, and told it is not active (CanvasActiveContext):
 * its overlays, keys, drops and search stand down (its project bar stays in the header), and an open composer, a quote or a running
 * card is exactly as it was when they come back.
 *
 * Below 1024 px the page's own three-way tabs (StudioSplit: Chat · Plan · My canvas) choose the view, and this column's switch is
 * not drawn.
 */
export function PlanColumn({ initialSession, children }: { initialSession: string | null; children: ReactNode }) {
  const { t } = useI18n();
  const c = t.studioLive;
  const p = c.plan;
  const phone = usePhone();
  // A short window (1440×900) keeps the board's rows: the film's Timeline starts folded under it (Pixel M2).
  const [tall, setTall] = useState(false);
  useEffect(() => setTall(window.innerHeight >= 1000), []);
  const path = useChannelPath();
  const split = useContext(StudioSplitContext);

  // The conversation: the page's ?brain= (kept in step by the panel's replaceState and New chat), or the one the panel named since.
  const params = useSearchParams();
  const raw = params?.get("brain") ?? null;
  const url = raw && SESSION.test(raw) ? raw : null;
  const [own, setOwn] = useState<{ sid: string | null } | undefined>(() => ({ sid: initialSession }));
  const lastUrl = useRef(url);
  useEffect(() => {
    if (lastUrl.current === url) return;
    lastUrl.current = url;
    setOwn(undefined);
  }, [url]);
  const session = own !== undefined ? own.sid : url;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // Deterministic for the server's render; the stored choice is read once mounted.
  const [view, setView] = useState<ColumnView>(initialSession ? "plan" : "canvas");
  const [announce, setAnnounce] = useState("");
  useEffect(() => {
    setView(initialView(readMemory(), initialSession));
    // Once, on open: later changes are the person's or a send's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A choice made before the conversation had an id is that conversation's once it has one.
  useEffect(() => {
    if (!session) return;
    const m = readMemory();
    const next = adoptSession(m, session);
    if (next !== m) writeMemory(next);
  }, [session]);

  const [activity, setActivity] = useState<BrainActivity | null>(null);
  /** A send is out and has not been answered: an "end" with no answer since is a failed turn (Pixel M3). */
  const awaiting = useRef(false);
  const [noAnswer, setNoAnswer] = useState(false);
  // The ids on the last board drawn; null: nothing drawn yet for a conversation that was already there (open, refresh, switch), so
  // what it has is not news. A new conversation started here (a send with no id yet) arrives card by card.
  const seen = useRef<Set<string> | null>(initialSession ? null : new Set());
  const freshStart = useRef(false);
  const [enter, setEnter] = useState<ReadonlyMap<string, number>>(NONE);
  const autoShown = useRef(p.autoShown);
  autoShown.current = p.autoShown;

  useEffect(
    () =>
      onBrainActivity((a) => {
        const mine = a.session_id === sessionRef.current;
        // A replay is what is still in flight, not an act: it never adopts, switches, remembers or announces (Lens H2).
        if (a.replayed) {
          if (mine && a.phase === "planning") setActivity(a);
          return;
        }
        if (a.phase === "thinking") {
          awaiting.current = true;
          setNoAnswer(false);
          // Sending starts the plan: the column shows it, unless the person chose their canvas in this same conversation.
          const v = viewOnSend(readMemory(), a.session_id);
          setView((was) => {
            if (was !== v && v === "plan") setAnnounce(autoShown.current);
            return v;
          });
          writeMemory({ session: a.session_id, view: v });
          // A send never replays an entrance already shown.
          setEnter(NONE);
          if (a.session_id === null) {
            // A new conversation: the last one's plan is not drawn under it, and every card of the new one arrives.
            freshStart.current = true;
            setOwn({ sid: null });
          } else if (!mine) setOwn({ sid: a.session_id });
          setActivity(a);
          return;
        }
        // "planning", "saving", "pricing" and "end" are about the conversation they name: another one's (a wait that outlived a
        // New chat) moves
        // nothing here, and never brings its plan back beside a new chat (Lens H1).
        if (!mine) return;
        if (a.phase === "end" && awaiting.current) {
          awaiting.current = false;
          setNoAnswer(true);
        }
        setActivity(a);
      }),
    [],
  );
  // A conversation's first answer names it: the column follows it before the URL does. The only other way in is a send ("thinking").
  useEffect(() => {
    const on = (e: Event) => {
      const sid = (e as CustomEvent<{ session_id?: unknown }>).detail?.session_id;
      if (typeof sid !== "string" || !SESSION.test(sid)) return;
      awaiting.current = false;
      setNoAnswer(false);
      if (sid !== sessionRef.current) setOwn({ sid });
    };
    window.addEventListener(BRAIN_BRIEF_EVENT, on);
    return () => window.removeEventListener(BRAIN_BRIEF_EVENT, on);
  }, []);
  // Create went through: this conversation's board turns to the film, and is shown (as a send shows it), unless the person chose their
  // own canvas in this same conversation.
  useEffect(
    () =>
      onBrainHandoff((h) => {
        if (h.session_id !== sessionRef.current) return;
        setHeard(h);
        // As a send does: shown and said, and remembered for this conversation.
        const v = viewOnSend(readMemory(), h.session_id);
        setView((was) => {
          if (was !== v && v === "plan") setAnnounce(autoShown.current);
          return v;
        });
        writeMemory({ session: h.session_id, view: v });
        // Focus goes to the board's title, never to a key that would leave for another page (Pixel H1, M4).
        if (v === "plan") setFocusTitle((n) => n + 1);
      }),
    [],
  );

  const [focusTitle, setFocusTitle] = useState(0);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!focusTitle) return;
    const id = requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [focusTitle]);

  const [selected, setSelected] = useState<string | null>(null);
  // Another conversation is a first reading (nothing "new" on it) unless this column started it from a send.
  const [seenFor, setSeenFor] = useState(session);
  if (seenFor !== session) {
    setSeenFor(session);
    setSelected(null);
  }
  useLayoutEffect(() => {
    if (session === null) {
      seen.current = new Set();
      return;
    }
    seen.current = freshStart.current ? new Set() : null;
    freshStart.current = false;
  }, [session]);

  const read = useBrainBrief(session);
  const brief = read.load.state === "ready" ? read.load.brief : null;
  const phase = activity && activity.session_id === session && activity.phase !== "end" ? activity.phase : null;
  const planCounts = phase === "planning" ? (activity?.plan ?? null) : null;

  // The film this conversation became, first from what this page heard (the panel's handoff), then from the server's record of it
  // (the brief's handoff: the truth after a refresh), then from the URL's `&film=` (a refresh before the brief is read, or a handoff
  // the server did not record). Each only for this conversation: another one's film is never drawn under it.
  const [heard, setHeard] = useState<BrainHandoff | null>(null);
  const urlFilmRaw = params?.get("film") ?? null;
  const urlFilm = url !== null && url === session && urlFilmRaw && SESSION.test(urlFilmRaw) ? urlFilmRaw.toLowerCase() : null;
  const briefFilm = brief?.handoff?.kind === "film" ? brief.handoff.filmId.toLowerCase() : null;
  const heardFilm = heard && heard.session_id === session ? heard.film_id : null;
  // The URL's film only while the brief is not read: once it is, the brief (or what this page heard) is the answer, and a URL film it
  // does not name is never drawn (Lens M1: a hand-edited or stale &film= drew a film this conversation never became).
  const briefRead = read.load.state === "ready";
  const filmId = heardFilm ?? (briefRead ? briefFilm : urlFilm);
  useEffect(() => {
    if (!briefRead || !session || !urlFilmRaw) return;
    const keep = heardFilm ?? briefFilm;
    if (urlFilmRaw.toLowerCase() === keep) return;
    const u = new URL(window.location.href);
    if (keep) u.searchParams.set("film", keep);
    else u.searchParams.delete("film");
    window.history.replaceState(null, "", u.toString());
  }, [briefRead, session, urlFilmRaw, heardFilm, briefFilm]);
  // Read only while the plan is on screen: behind My canvas or the Chat tab nothing is polled; the last reading stays, and reading
  // resumes when the plan is shown again (useLiveGraph keeps a reading of the same film across the pause).
  const onScreen = split ? split.tab === "plan" : view === "plan";
  const target = useMemo<LiveTarget | null>(() => (filmId && onScreen ? { kind: "film", id: filmId } : null), [filmId, onScreen]);
  const live = useLiveGraph(target);
  const filmKey = filmId ? `film:${filmId}` : null;
  // A film from the URL is read at once, beside the brief, but drawn only once the brief has had its say (Lens M1, M3): a reading of a
  // film the brief does not name never reaches the board, and the brief's cast is there when the film is drawn. A brief that cannot be
  // read leaves the URL's film as the only answer; the film's own route still decides who may read it.
  const filmTrusted = !!heardFilm || read.load.state !== "loading";
  const liveGraph = filmTrusted && live.load.state === "ready" && live.load.key === filmKey ? live.load.graph : null;

  // One model across Create (`plan` stays the conversation): the film's reading folds into the brief's board, the same cards by id.
  const boardInput = useMemo<BoardInput | null>(
    () => (liveGraph ? { source: "live", graph: liveGraph, brief } : brief ? { source: "brief", brief, writing: phase === "planning" } : null),
    [liveGraph, brief, phase],
  );
  const model = useBoardModel(boardInput, session);
  const making = model?.stage === "making" || model?.stage === "assembled";
  const graph = model?.graph ?? null;
  const items = useMemo(() => (graph ? planItems(graph) : null), [graph]);
  const ids = useMemo(() => (items ? [...items.top.map((n) => n.id), ...items.scenes.map((s) => s.id), ...items.footer.map((n) => n.id)] : null), [items]);

  // What is new since the last board, worked out before paint so a card never shows once and then animates in.
  useLayoutEffect(() => {
    if (!ids) return;
    const next = reduced() ? NONE : enteringIds(seen.current, ids);
    seen.current = new Set(ids);
    setEnter(next.size ? next : NONE);
  }, [ids]);
  // The entrance plays once: the marks are taken off when it is over, so nothing a later render does can play it again.
  useEffect(() => {
    if (!enter.size) return;
    const last = Math.max(...enter.values());
    const id = setTimeout(() => setEnter(NONE), last * STAGGER_MS + REVEAL_MS + 100);
    return () => clearTimeout(id);
  }, [enter]);

  // Measured on this screen, never estimated: how long the turn or the storyboard has been out.
  const [phaseAt, setPhaseAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!phase) {
      setPhaseAt(null);
      return;
    }
    const at = Date.now();
    setPhaseAt(at);
    setNow(at);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);
  const elapsed = phaseAt !== null ? now - phaseAt : 0;

  // A card's id is the step it opens: a scene card (`scene#n`) opens its picture step.
  const onOpen = useCallback((id: string) => setSelected(/^scene#\d+$/.test(id) ? `${id}:keyframe` : id), []);
  const sel = graph?.nodes.find((n) => n.id === selected) ?? null;
  const cards = useMemo(() => (items ? planCards(t, items, { selected, onOpen, enter, live: making }) : []), [t, items, selected, onOpen, enter, making]);

  // The timing harness's marks (tools/visual-qa/timing): taken once the state that draws the thing is committed.
  const hasCards = cards.length > 0;
  // What the film's first reading already had done is not "lit": only a step that turned working or done since (Lens nit).
  const firstDone = useRef<{ key: string; ids: Set<string> } | null>(null);
  if (liveGraph && filmKey && firstDone.current?.key !== filmKey)
    firstDone.current = { key: filmKey, ids: new Set(liveGraph.nodes.filter((n) => n.status === "done").map((n) => n.id)) };
  const lit = making && !!graph && hasLitStep(graph, firstDone.current?.ids);
  useEffect(() => {
    if (hasCards) nsMarkOnce(making ? "ns:live:first-card" : "ns:plan:first-card");
  }, [hasCards, making]);
  useEffect(() => {
    if (phase === "planning") nsMarkOnce("ns:plan:storyboard-start");
  }, [phase]);
  useEffect(() => {
    if (lit) nsMarkOnce("ns:live:first-lit");
  }, [lit]);

  // Closing a step gives focus back to its card, focused before the details unmount (or the browser drops it to <body>); Escape
  // closes it wherever focus is, and is taken, so nothing else on the page reads it as "leave" (Pixel H5).
  const close = useCallback(() => {
    if (!selected) return setSelected(null);
    const card = cardOf(selected);
    const focusCard = () =>
      [...document.querySelectorAll<HTMLElement>("[data-node-id]")].find((el) => el.dataset.nodeId === card)?.focus({ preventScroll: true });
    focusCard();
    setSelected(null);
    // The details are a drawer over the board (the grid never reflows), but React Flow may re-render the card as they go: if focus
    // fell to <body> on the way, it is put back once the frame after next has settled (Pixel N3: lost 3 times in 6).
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (document.activeElement === document.body || !document.activeElement) focusCard();
      }),
    );
  }, [selected]);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected]);

  const choose = (v: ColumnView) => {
    if (split) {
      split.setTab(v);
      return;
    }
    setView(v);
    setAnnounce("");
    writeMemory({ session, view: v });
    // Cards already shown are not news when the person comes back to the plan.
    setEnter(NONE);
  };

  const showCanvas = (
    <button type="button" className="cv-kbtn plan-key" onClick={() => choose("canvas")} data-testid="plan-show-canvas">
      {p.showCanvas}
    </button>
  );
  const planning = (
    <div className="plan-skeleton" role="status" data-testid="plan-thinking">
      <div className="plan-skeleton-row" aria-hidden>
        <span className="plan-skel" />
        <span className="plan-skel" />
        <span className="plan-skel is-small" />
      </div>
      <p className="ds-t-caption">
        {elapsed >= STILL_WORKING_MS ? p.stillWorking : p.planning}{" "}
        <span className="ds-mono">{fmt(p.elapsed, { time: clock(elapsed) })}</span>
      </p>
    </div>
  );

  // One line under the title, the same element in every state, so the board never moves when its words change (Pixel H3, M1): the
  // plan before Create; once started, the film's progress being read, or why it cannot be; while it is made, how it is followed.
  const ls = live.load.state;
  const loginHref = `/login?next=${encodeURIComponent(typeof window === "undefined" ? "/" : window.location.pathname + window.location.search)}`;
  let statusLine: { text: ReactNode; id: string; alert?: boolean } | null = null;
  if (filmId) {
    if (making && graph) statusLine = { text: live.stale ? c.stale : graph.settled ? c.settled : p.making, id: live.stale ? "plan-live-stale" : "plan-making" };
    else if (ls === "error") {
      statusLine = {
        id: "plan-live-error",
        alert: true,
        text: (
          <>
            {p.film.readFailed}{" "}
            <button type="button" className="plan-inline-key" onClick={live.retry}>
              {c.retry}
            </button>
          </>
        ),
      };
    } else if (ls === "expired")
      statusLine = { id: "plan-live-expired", alert: true, text: <>{p.film.expired} <Link href={loginHref}>{c.signIn}</Link></> };
    else if (ls === "notFound") statusLine = { id: "plan-live-notfound", text: p.film.notFound };
    else if (ls === "unavailable") statusLine = { id: "plan-live-unavailable", text: p.film.unavailable };
    else statusLine = { id: "plan-started", text: p.started };
  } else if (graph) statusLine = { id: "plan-note", text: p.headerNote };

  let body: ReactNode = null;
  if (items) {
    body = (
      <div className={`lv-main plan-stage${sel ? " has-details" : ""}`} data-stage={model?.stage}>
        {phone ? <PlanList cards={cards} /> : <PlanBoard cards={cards} items={items} fitOn={making ? filmKey : null} />}
        {sel ? <Details node={sel} run={false} filmId={making ? filmId : null} video={making ? graph?.video : undefined} onClose={close} /> : null}
      </div>
    );
  } else if (phase === "thinking") body = planning;
  else if (phase === "planning") body = null;
  else if (phase === "saving" || phase === "pricing") body = <p className="ds-t-caption plan-quiet" role="status" data-testid="plan-busy">{phase === "saving" ? p.saving : p.pricing}</p>;
  else if (noAnswer) body = <p className="ds-t-body-sm plan-empty" role="status" data-testid="plan-no-answer">{p.noAnswer}</p>;
  else if (!session) body = <p className="ds-t-body-sm plan-empty" data-testid="plan-empty">{p.empty}</p>;
  else if (read.load.state === "loading") body = <p className="ds-t-caption" role="status" data-testid="plan-loading">{c.briefLoading}</p>;
  else if (read.load.state === "expired")
    body = (
      <p role="alert" data-testid="plan-expired" className="ds-t-body-sm">
        {c.expired}{" "}
        <Link href={`/login?next=${encodeURIComponent(typeof window === "undefined" ? "/" : window.location.pathname + window.location.search)}`}>{c.signIn}</Link>
      </p>
    );
  else if (read.load.state === "notFound")
    body = (
      <div className="plan-state" data-testid="plan-notfound">
        <p className="ds-t-body-sm">{c.briefNotFound}</p>
        <div className="plan-keys">
          <Link className="cv-kbtn plan-key" href={path("/studio?ai=new")} data-testid="plan-new-conversation">
            {p.newConversation}
          </Link>
          {showCanvas}
        </div>
      </div>
    );
  else if (read.load.state === "unavailable")
    body = (
      <div className="plan-state" data-testid="plan-unavailable">
        <p className="ds-t-body-sm">{c.briefUnavailable}</p>
        <div className="plan-keys">{showCanvas}</div>
      </div>
    );
  else
    body = (
      <div className="plan-state" role="alert" data-testid="plan-error">
        <p className="ds-t-body-sm">{c.briefReadFailed}</p>
        <div className="plan-keys">
          <button type="button" className="cv-kbtn plan-key" onClick={read.retry}>
            {c.retry}
          </button>
        </div>
      </div>
    );

  // What is on screen: the page's tabs below 1024 px, this column's own switch at a desk.
  const shown: ColumnView = split ? (split.tab === "canvas" ? "canvas" : "plan") : view;
  const absent = items?.absent ?? [];
  // "…in this plan" before Create, "…in this film" once it is being made (Pixel L2).
  const ab = making ? p.absentFilm : p.absent;
  const absentLine = absent.length === 2 ? ab.voiceMusic : absent[0] === "voice" ? ab.voice : absent[0] === "music" ? ab.music : null;

  return (
    <div className="plan-col" data-view={shown} data-testid="studio-plan-column">
      {split ? null : (
      <SegTabs
        items={[
          { id: "plan" as const, label: p.plan },
          { id: "canvas" as const, label: p.canvas },
        ]}
        value={shown}
        onChange={choose}
        label={p.switchLabel}
        idBase="plan-col"
        className="cv-tok plan-switch"
        testIdBase="plan-switch"
      />
      )}
      {/* Outside the panes, so it is there before and after a switch: "Showing the plan" when a send switched it for them. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="plan-announce">
        {announce}
        {enter.size > 0 ? ` ${fmt(p.arrived, { n: enter.size })}` : ""}
      </p>
      <div className="plan-col-stack">
        {shown === "plan" ? (
          <section {...tabPanelProps("plan-col", "plan")} className="cv-root lv-root plan-root" data-testid="plan-board-pane" data-phase={phase ?? "end"} data-stage={model?.stage}>
            <header className="plan-head">
              <h2 className="ds-t-heading-xl plan-title" ref={titleRef} tabIndex={-1}>
                {brief?.title || p.title}
              </h2>
              {statusLine ? (
                <p className="ds-t-caption plan-status" role={statusLine.alert ? "alert" : "status"} data-testid={statusLine.id}>
                  {statusLine.text}
                </p>
              ) : null}
              {graph && phase === "thinking" ? (
                <p className="ds-t-caption plan-quiet" data-testid="plan-thinking">
                  {elapsed >= STILL_WORKING_MS ? p.stillWorking : p.planning}
                </p>
              ) : null}
              {graph && (phase === "saving" || phase === "pricing") ? (
                <p className="ds-t-caption plan-quiet" role="status" data-testid="plan-busy">
                  {phase === "saving" ? p.saving : p.pricing}
                </p>
              ) : null}
              {graph && read.stale ? <p className="ds-t-caption lv-stale" data-testid="plan-stale">{p.stale}</p> : null}
            </header>
            {split && model?.stage === "proposing" && !phase ? (
              // On a phone the chat is another tab: an answer that waits for the person's choice is said here, with the way to it.
              <div className="plan-state plan-answered" role="status" data-testid="plan-answered">
                <p className="ds-t-body-sm">{p.answered}</p>
                <div className="plan-keys">
                  <button type="button" className="cv-kbtn plan-key" onClick={() => split.setTab("chat")}>
                    {p.openChat}
                  </button>
                </div>
              </div>
            ) : null}
            {phase === "planning" ? (
              // A row of its own above the board, never over the cards, with the time measured here. A chapter count only when the
              // server reported one (#989's plan counts); without it an indeterminate sweep and no number (CLAUDE.md rule 5).
              <div className="plan-writing" role="status" data-testid="plan-storyboard">
                <p className="ds-t-body-sm plan-writing-head">
                  {planCounts
                    ? fmt(p.chapterOf, { n: Math.min(planCounts.chapters_written + 1, planCounts.chapters), total: planCounts.chapters })
                    : p.storyboard}{" "}
                  <span className="ds-mono ds-t-caption">{fmt(p.elapsed, { time: clock(elapsed) })}</span>
                </p>
                <p className="ds-t-caption">{p.storyboardNote}</p>
                <span className="plan-sweep" aria-hidden />
              </div>
            ) : null}
            {body}
            {making && filmKey ? (
              <div className="plan-live-below" data-testid="plan-live-below">
                <LiveLane load={live.load} planKey={filmKey} stale={live.stale} selected={selected} onOpen={setSelected} retry={live.retry}
                  storageKey={PLAN_LANE_KEY} defaultOpen={tall && !phone} />
                {graph?.activity ? <PlanActivity activity={graph.activity} /> : null}
              </div>
            ) : null}
            {items && absentLine ? <p className="ds-t-caption plan-absent">{absentLine}</p> : null}
          </section>
        ) : null}
        <div
          {...tabPanelProps("plan-col", "canvas")}
          className="plan-col-canvas"
          inert={shown !== "canvas"}
          aria-hidden={shown !== "canvas" || undefined}
          data-hidden={shown !== "canvas" ? "" : undefined}
          data-testid="plan-canvas-pane"
        >
          <CanvasActiveContext.Provider value={shown === "canvas"}>{children}</CanvasActiveContext.Provider>
        </div>
      </div>
    </div>
  );
}
