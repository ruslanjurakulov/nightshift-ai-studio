"use client";

import { createContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { onBrainActivity, onBrainHandoff, type BrainPhase } from "@/lib/studio/brainActivity";
import { BRAIN_BRIEF_EVENT } from "./useBrainBrief";
import { SegTabs, tabPanelProps } from "./SegTabs";

const NARROW = "(max-width: 1023px)";
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SplitTab = "chat" | "plan" | "canvas";
/**
 * Below 1024 px the Studio is one three-way tablist (Chat · Plan · My canvas); the Plan column then hides its own Plan / My canvas
 * switch and shows what the third tab says. Null at a desk, where the column keeps its own switch.
 */
export const StudioSplitContext = createContext<{ tab: SplitTab; setTab: (t: SplitTab) => void } | null>(null);

/**
 * The Studio page with Nightshift AI: the chat and the column beside it (PlanColumn). From 1024 px they sit side by side. Below, the
 * plan stacked under a full-height chat was never seen (Pixel H4), so they are tabs, one at a time, all kept mounted (a half typed
 * message, the plan's state and the person's canvas survive a switch).
 *
 * The first send of a conversation opens the plan; later sends do not, since the person may be typing a follow-up. A chip above the
 * chat says what the plan is doing and opens it; the Chat tab carries a dot when an answer lands while the person is elsewhere.
 * Only the current conversation's activity counts: another one's (a wait that outlived a New chat) moves nothing here.
 */
export function StudioSplit({
  chat,
  column,
  initialSession = null,
  className = "",
}: {
  chat: ReactNode;
  column: ReactNode;
  initialSession?: string | null;
  className?: string;
}) {
  const { t } = useI18n();
  const p = t.studioLive.plan;
  const [narrow, setNarrow] = useState(false);
  const [tab, setTabState] = useState<SplitTab>("chat");
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [phase, setPhase] = useState<BrainPhase | null>(null);
  const [hasPlan, setHasPlan] = useState(!!initialSession);
  const [unread, setUnread] = useState(false);
  const current = useRef<string | null>(initialSession);
  const setTab = (next: SplitTab) => {
    setTabState(next);
    if (next === "chat") setUnread(false);
  };
  // New chat takes ?brain= off the page (the panel's router.replace): nothing of the last conversation stays on the chip or the tab.
  const params = useSearchParams();
  const brain = params?.get("brain") ?? null;
  const lastBrain = useRef(brain);
  useEffect(() => {
    const was = lastBrain.current;
    lastBrain.current = brain;
    if (was && !brain) {
      current.current = null;
      setPhase(null);
      setHasPlan(false);
      setUnread(false);
    }
  }, [brain]);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(NARROW);
    setNarrow(m.matches);
    const on = () => setNarrow(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  useEffect(
    () =>
      onBrainActivity((a) => {
        if (a.phase === "thinking" && !a.replayed) {
          current.current = a.session_id;
          setPhase("thinking");
          if (a.session_id === null) {
            setHasPlan(false);
            setTabState("plan");
          }
          return;
        }
        if (a.session_id !== current.current) return;
        setPhase(a.phase === "end" ? null : a.phase);
      }),
    [],
  );
  useEffect(() => {
    const on = (e: Event) => {
      const sid = (e as CustomEvent<{ session_id?: unknown }>).detail?.session_id;
      if (typeof sid !== "string" || !SESSION.test(sid)) return;
      current.current = sid;
      setHasPlan(true);
      // An answer landed: if the person is not in the chat, the Chat tab says so.
      if (tabRef.current !== "chat") setUnread(true);
    };
    window.addEventListener(BRAIN_BRIEF_EVENT, on);
    return () => window.removeEventListener(BRAIN_BRIEF_EVENT, on);
  }, []);
  // Create went through: the film is made on the Plan tab (the board in place of the old live page), so that is where the person is
  // taken, as the first send takes them to the plan. Another conversation's handoff moves nothing.
  useEffect(
    () =>
      onBrainHandoff((h) => {
        if (h.session_id !== current.current) return;
        setHasPlan(true);
        setTabState("plan");
      }),
    [],
  );

  const chip =
    narrow && tab === "chat" && (phase || hasPlan) ? (
      <button type="button" className="ds-chip studio-split-chip" onClick={() => setTab("plan")} data-testid="studio-plan-chip">
        {phase === "thinking" ? p.chip.planning : phase === "planning" ? p.chip.storyboard : p.chip.open}
      </button>
    ) : null;
  // Below 1024 px the chat fills the window from where it starts down to the app's tab bar: where it starts (under the banner, the
  // header, the tabs and the chip) is measured, as the canvas measures its own top (--cv-top), so the composer is never under the
  // tab bar (Pixel L-a: 78-82 px under it with a fixed guess).
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!narrow || !root) return;
    const size = () => {
      const dock = root.querySelector<HTMLElement>(".ns-ai-dock");
      if (dock) root.style.setProperty("--split-dock-top", `${Math.max(0, dock.getBoundingClientRect().top + window.scrollY)}px`);
    };
    size();
    window.addEventListener("resize", size);
    return () => window.removeEventListener("resize", size);
  }, [narrow, tab, phase, hasPlan]);
  const panelProps = (id: "chat" | "plan") => (narrow ? tabPanelProps("studio-split", id) : {});
  return (
    <StudioSplitContext.Provider value={narrow ? { tab, setTab } : null}>
      <div ref={rootRef} className={`studio-split ${className}`} data-tab={narrow ? tab : undefined} data-testid="studio-split">
        {narrow ? (
          <SegTabs
            items={[
              { id: "chat" as const, label: p.views.chat, dot: unread ? p.views.unread : undefined },
              { id: "plan" as const, label: p.views.plan },
              { id: "canvas" as const, label: p.canvas },
            ]}
            value={tab}
            onChange={setTab}
            label={p.views.label}
            idBase="studio-split"
            // One tabpanel holds both the plan and the canvas (the column): "canvas" controls it too.
            panelFor={(id) => (id === "chat" ? "chat" : "plan")}
            className="cv-tok plan-switch studio-split-tabs"
            testIdBase="studio-tab"
          />
        ) : null}
        <div {...panelProps("chat")} className="studio-split-chat min-w-0">
          {chip}
          {chat}
        </div>
        <div {...panelProps("plan")} className="studio-split-plan min-w-0">
          {column}
        </div>
      </div>
    </StudioSplitContext.Provider>
  );
}
