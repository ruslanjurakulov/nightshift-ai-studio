"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n/context";
import { onBrainActivity, type BrainPhase } from "@/lib/studio/brainActivity";
import { BRAIN_BRIEF_EVENT } from "./useBrainBrief";
import { SegTabs, tabPanelProps } from "./SegTabs";

const NARROW = "(max-width: 1023px)";

/**
 * The Studio page with Nightshift AI: the chat and the column beside it (PlanColumn). From 1024 px they sit side by side. Below, the
 * plan stacked under a full-height chat was never seen (Pixel H4), so the two are tabs, one at a time, both kept mounted (a half
 * typed message and the plan's state survive a switch).
 *
 * The first send of a conversation switches to the plan; later sends do not, since the person may be typing a follow-up. A chip
 * above the chat says what the plan is doing and opens it.
 */
export function StudioSplit({ chat, column, className = "" }: { chat: ReactNode; column: ReactNode; className?: string }) {
  const { t } = useI18n();
  const p = t.studioLive.plan;
  const [narrow, setNarrow] = useState(false);
  const [tab, setTab] = useState<"chat" | "plan">("chat");
  const [phase, setPhase] = useState<BrainPhase | null>(null);
  const [hasPlan, setHasPlan] = useState(false);
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
        setPhase(a.phase === "idle" ? null : a.phase);
        if (a.phase === "thinking" && a.session_id === null) {
          setHasPlan(false);
          setTab("plan");
        }
      }),
    [],
  );
  useEffect(() => {
    const on = () => setHasPlan(true);
    window.addEventListener(BRAIN_BRIEF_EVENT, on);
    return () => window.removeEventListener(BRAIN_BRIEF_EVENT, on);
  }, []);

  const chip = narrow && tab === "chat" && (phase || hasPlan) ? (
    <button type="button" className="ds-chip studio-split-chip" onClick={() => setTab("plan")} data-testid="studio-plan-chip">
      {phase === "thinking" ? p.chip.planning : phase === "storyboard" ? p.chip.storyboard : p.chip.open}
    </button>
  ) : null;
  const panelProps = (id: "chat" | "plan") => (narrow ? tabPanelProps("studio-split", id) : {});
  return (
    <div className={`studio-split ${className}`} data-tab={narrow ? tab : undefined} data-testid="studio-split">
      {narrow ? (
        <SegTabs
          items={[
            { id: "chat" as const, label: p.views.chat },
            { id: "plan" as const, label: p.views.plan },
          ]}
          value={tab}
          onChange={setTab}
          label={p.views.label}
          idBase="studio-split"
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
  );
}
