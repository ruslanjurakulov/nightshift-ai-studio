"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ClientBadge } from "@/components/docs/McpClientContext";

export type HowTab = {
  id: string;
  tab: string;
  title: string;
  body: string;
  prompt: string;
  reply: string;
  rows: { id: string; say: string }[];
  result: string;
};

export type HowLabels = {
  tablist: string;
  you: string;
  agent: string;
  tool: string;
  pane: string;
  example: string;
};

/**
 * "How it works": use-case pills over one scripted conversation. The pills are
 * a real tablist (arrow keys, Home, End, one Tab stop); every panel is in the
 * page, the closed ones `hidden`, so a no-JS reader or a crawler finds all
 * three. The conversation shows the REAL tool names an assistant calls, and the
 * right-hand job card is a drawn product state, an example, not a recording:
 * it says so. When a panel opens its lines come in one after another (CSS
 * only, from site.css); under prefers-reduced-motion nothing moves and every
 * line is simply there.
 */
export function HowTabs({ tabs, labels }: { tabs: HowTab[]; labels: HowLabels }) {
  const uid = useId();
  const [active, setActive] = useState(tabs[0].id);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const root = useRef<HTMLDivElement>(null);
  // The conversation waits (paused at its first frame) until it is on screen, so nobody scrolls in on a finished scene.
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = root.current;
    if (!el || typeof IntersectionObserver === "undefined") return setSeen(true);
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.25 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  function choose(id: string, focus = false) {
    setActive(id);
    if (focus) refs.current[id]?.focus();
  }
  function onKey(e: React.KeyboardEvent, index: number) {
    const last = tabs.length - 1;
    const next =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? index === last ? 0 : index + 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? index === 0 ? last : index - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    if (next === -1) return;
    e.preventDefault();
    choose(tabs[next].id, true);
  }

  return (
    <div className="st-how-tabs" ref={root} data-seen={seen}>
      <noscript>
        <style>{`.st-how-panel[hidden]{display:grid!important}.st-how-panel{margin-bottom:24px}.st-how-pills{display:none!important}.st-how-tabs[data-seen] .st-reveal{animation-play-state:running!important}`}</style>
      </noscript>
      <div className="st-how-pills-wrap">
        <div role="tablist" aria-label={labels.tablist} className="st-how-pills">
          {tabs.map((t, i) => (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`${uid}-tab-${t.id}`}
              aria-selected={t.id === active}
              aria-controls={`${uid}-panel-${t.id}`}
              tabIndex={t.id === active ? 0 : -1}
              className="st-how-pill"
              onClick={() => choose(t.id)}
              onKeyDown={(e) => onKey(e, i)}
            >
              {t.tab}
            </button>
          ))}
        </div>
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`${uid}-panel-${t.id}`}
          aria-labelledby={`${uid}-tab-${t.id}`}
          hidden={t.id !== active}
          className="st-how-panel"
        >
          <div className="st-chat">
            <div className="st-chat-head">
              <h3 className="st-chat-title">{t.title}</h3>
              <p className="st-body">{t.body}</p>
            </div>
            <div className="st-msg st-reveal" data-who="you" style={{ animationDelay: "0s" }}>
              <span className="st-msg-who">{labels.you}</span>
              <p>{t.prompt}</p>
            </div>
            <div className="st-msg st-reveal" data-who="agent" style={{ animationDelay: "0.5s" }}>
              <span className="st-msg-who">
                {labels.agent}
                <ClientBadge />
                <span className="st-typing" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <p className="st-reveal" style={{ animationDelay: "1.4s" }}>
                {t.reply}
              </p>
            </div>
            <div className="st-tool st-reveal" style={{ animationDelay: "2s" }}>
              <span className="st-msg-who">{labels.tool}</span>
              <p className="st-tool-chips">
                {t.rows.map((r, i) => (
                  <code key={`${r.id}-${i}`}>{r.id}</code>
                ))}
              </p>
            </div>
            <div className="st-msg st-reveal" data-who="agent" style={{ animationDelay: "4.2s" }}>
              <span className="st-msg-who">{labels.agent}</span>
              <p>{t.result}</p>
            </div>
          </div>
          <div className="st-job">
            <div className="st-job-head">
              <span className="st-job-title">{labels.pane}</span>
              <span className="st-job-tag">{labels.example}</span>
            </div>
            <ol className="st-job-rows">
              {t.rows.map((r, i) => {
                const last = i === t.rows.length - 1;
                return (
                  <li key={`${r.id}-${i}`} className="st-reveal" style={{ animationDelay: `${2.4 + i * 0.5}s` }} data-wait={r.id === "publish_video" || undefined}>
                    <span className="st-job-lamp" aria-hidden data-last={last || undefined} />
                    <code>{r.id}</code>
                    <span>{r.say}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      ))}
    </div>
  );
}
