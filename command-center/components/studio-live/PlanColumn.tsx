"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { onBrainActivity, type BrainActivity } from "@/lib/studio/brainActivity";
import {
  adoptSession,
  enteringCards,
  initialView,
  parseViewMemory,
  VIEW_MEMORY_KEY,
  viewOnSend,
  type ColumnView,
  type ViewMemory,
} from "@/lib/studio/planBoard";
import { BRAIN_BRIEF_EVENT, useBrainBrief } from "./useBrainBrief";
import { reduced, StoryBoard } from "./StoryBoard";
import { useBoardModel } from "./useBoardModel";
import { Details } from "./LiveView";
import type { BoardInput } from "@/lib/studio/boardModel";
import "@/components/studio-canvas/studio-canvas.css";
import "./studio-live.css";

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONE: ReadonlyMap<string, number> = new Map();
const NO_LIT: ReadonlySet<string> = new Set();

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

/**
 * The Studio's column beside Nightshift AI (docs/studio/S3_LIVE_MEASURE.md). Measured on main, the canvas there never changed during a
 * whole conversation: nothing on it read the brief. Now the column shows the plan as the conversation builds it, read once per finished
 * turn (the panel's `nightshift:brain-brief`, through useBrainBrief), and says when a turn or a storyboard is out (the panel's
 * `nightshift:brain-activity`). No timer and no new route.
 *
 * Read-only (CLAUDE.md rule 3): the board draws DRAFT steps; nothing on it starts, prices or spends. Create stays in the panel.
 *
 * The person's own canvas stays mounted while the plan is shown (hidden and inert, never unmounted), so an open composer, a quote or a
 * running card is exactly as it was when they switch back.
 */
export function PlanColumn({ initialSession, children }: { initialSession: string | null; children: ReactNode }) {
  const { t } = useI18n();
  const c = t.studioLive;
  const p = c.plan;

  // The conversation: the page's ?brain= (kept in step by the panel's replaceState and New chat), or the one an event named since.
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
  // The ids on the last board read; null: nothing read yet on a column that opened with a plan, so what is there is not news.
  const seen = useRef<Set<string> | null>(initialSession ? null : new Set());
  useEffect(
    () =>
      onBrainActivity((a) => {
        setActivity(a);
        if (a.phase === "thinking") {
          // Sending starts the plan: the column shows it, unless the person chose their canvas in this same conversation.
          const v = viewOnSend(readMemory(), a.session_id);
          setView(v);
          writeMemory({ session: a.session_id, view: v });
          if (a.session_id === null) {
            // A new conversation: the last one's plan is not drawn under it, and every card of the new one arrives.
            setOwn({ sid: null });
            seen.current = new Set();
            return;
          }
        }
        if (a.session_id && a.session_id !== sessionRef.current) setOwn({ sid: a.session_id });
      }),
    [],
  );
  // A conversation's first answer names it: the board follows it before the URL does.
  useEffect(() => {
    const on = (e: Event) => {
      const sid = (e as CustomEvent<{ session_id?: unknown }>).detail?.session_id;
      if (typeof sid === "string" && SESSION.test(sid) && sid !== sessionRef.current) setOwn({ sid });
    };
    window.addEventListener(BRAIN_BRIEF_EVENT, on);
    return () => window.removeEventListener(BRAIN_BRIEF_EVENT, on);
  }, []);
  useEffect(() => {
    if (!session) seen.current = new Set();
  }, [session]);

  const read = useBrainBrief(session);
  const brief = read.load.state === "ready" ? read.load.brief : null;
  const phase = activity && activity.session_id === session && activity.phase !== "idle" ? activity.phase : null;
  const boardInput = useMemo<BoardInput | null>(() => (brief ? { source: "brief", brief, writing: phase === "storyboard" } : null), [brief, phase]);
  const model = useBoardModel(boardInput, session);
  const graph = model?.graph ?? null;
  const [enter, setEnter] = useState<ReadonlyMap<string, number>>(NONE);
  useEffect(() => {
    if (!graph) return;
    const next = reduced() ? NONE : enteringCards(seen.current, graph);
    seen.current = new Set(graph.nodes.map((n) => n.id));
    setEnter(next);
  }, [graph]);

  const [selected, setSelected] = useState<string | null>(null);
  const sel = graph?.nodes.find((n) => n.id === selected) ?? null;

  const choose = (v: ColumnView) => {
    setView(v);
    writeMemory({ session, view: v });
    // Cards already shown are not news when the person comes back to the plan.
    setEnter(NONE);
  };

  let body: ReactNode = null;
  if (graph) {
    body = (
      <div className={`lv-main plan-stage${sel ? " has-details" : ""}`} data-stage={model?.stage}>
        <StoryBoard graph={graph} selected={selected} onOpen={setSelected} lit={NO_LIT} enter={enter} follow />
        {phase === "storyboard" ? <Storyboard words={p} /> : null}
        {sel ? <Details node={sel} run={false} filmId={null} onClose={() => setSelected(null)} /> : null}
      </div>
    );
  } else if (phase === "storyboard") body = <Storyboard words={p} />;
  else if (!session && phase !== "thinking") body = <p className="plan-empty" data-testid="plan-empty">{p.empty}</p>;
  else if (phase === "thinking" || read.load.state === "loading")
    body =
      phase === "thinking" ? (
        <p className="plan-quiet" role="status" data-testid="plan-planning">{p.planning}</p>
      ) : (
        <p className="lv-muted" role="status" data-testid="plan-loading">{c.briefLoading}</p>
      );
  else if (read.load.state === "expired")
    body = (
      <p role="alert" data-testid="plan-expired">
        {c.expired}{" "}
        <Link href={`/login?next=${encodeURIComponent(typeof window === "undefined" ? "/" : window.location.pathname + window.location.search)}`}>{c.signIn}</Link>
      </p>
    );
  else if (read.load.state === "notFound") body = <p data-testid="plan-notfound">{c.briefNotFound}</p>;
  else if (read.load.state === "unavailable") body = <p data-testid="plan-unavailable">{c.briefUnavailable}</p>;
  else
    body = (
      <div role="alert" data-testid="plan-error">
        <p>{c.briefReadFailed}</p>
        <button type="button" className="cv-kbtn" onClick={read.retry}>
          {c.retry}
        </button>
      </div>
    );

  return (
    <div className="plan-col" data-view={view} data-testid="studio-plan-column">
      <div className="cv-tok plan-switch" role="group" aria-label={p.switchLabel}>
        <button type="button" aria-pressed={view === "plan"} onClick={() => choose("plan")} data-testid="plan-switch-plan">
          {p.plan}
        </button>
        <button type="button" aria-pressed={view === "canvas"} onClick={() => choose("canvas")} data-testid="plan-switch-canvas">
          {p.canvas}
        </button>
      </div>
      <div className="plan-col-stack">
        {view === "plan" ? (
          <section className="cv-root lv-root plan-root" aria-label={p.title} data-testid="plan-board-pane" data-phase={phase ?? "idle"}>
            <header className="lv-head">
              <h2 className="plan-title">{brief?.title || p.title}</h2>
              <p className="lv-muted">{c.draftNote}</p>
              {graph && phase === "thinking" ? (
                <p className="plan-quiet" data-testid="plan-planning">{p.planning}</p>
              ) : null}
              {graph && read.stale ? <p className="lv-stale" data-testid="plan-stale">{p.stale}</p> : null}
              <p className="sr-only" role="status" aria-live="polite">
                {enter.size > 0 ? fmt(p.arrived, { n: enter.size }) : ""}
              </p>
            </header>
            {body}
          </section>
        ) : null}
        <div className="plan-col-canvas" inert={view !== "canvas"} data-hidden={view !== "canvas" ? "" : undefined} data-testid="plan-canvas-pane">
          {children}
        </div>
      </div>
    </div>
  );
}

/** The storyboard is being written: an indeterminate sweep and what is true, never a per-scene count the server does not report. */
function Storyboard({ words }: { words: { storyboard: string; storyboardNote: string } }) {
  return (
    <div className="plan-writing" role="status" data-testid="plan-storyboard">
      <p className="plan-writing-head">{words.storyboard}</p>
      <p className="plan-writing-note">{words.storyboardNote}</p>
      <span className="plan-sweep" aria-hidden />
    </div>
  );
}
