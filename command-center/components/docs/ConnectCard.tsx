"use client";

import { useEffect, useId, useRef, useState } from "react";

export type ConnectTab = {
  id: string;
  label: string;
  /** The client's logo (or its neutral monogram), drawn on the server; decorative, the label is beside it. */
  glyph: React.ReactNode;
  /** The surface the logo needs: the page's neutral tile, or a light "paper" tile on both themes. */
  tile: "theme" | "paper" | "bare";
  group: "primary" | "more";
  /** The tab's steps, rendered on the server. Absent when `soon` is set. */
  panel?: React.ReactNode;
  /** Not available yet: said honestly instead of a step list that cannot work. */
  soon?: { badge: string; title: string; body: string; use: string; goto: { id: string; label: string }[] };
};

/**
 * The connect card's tabs: pill tabs over panels, one panel per assistant.
 *
 * The server renders EVERY panel and picks the open tab from `?tab=`, so a
 * link opens on the right tab with no flash, and no-JS readers and crawlers
 * find every tab's steps (a noscript rule lays them out one under another).
 * ARIA tablist/tab/tabpanel with `aria-controls`; arrow keys, Home and End move
 * between tabs and only the open tab is a Tab stop. A click changes the address
 * to `?tab=<id>` with replaceState (no history entry), and an old `#<id>` link
 * still opens its tab. On a phone the strip scrolls sideways and the open pill
 * is scrolled into view.
 *
 * From 768px up the panels share one grid cell and the closed ones are
 * invisible (visibility, so they leave the tab order and the accessibility
 * tree): the card is as tall as its tallest panel and never jumps on a change.
 */
export function ConnectCard({
  tabs,
  initialId,
  title,
  tablistLabel,
  moreLabel,
  banner,
}: {
  tabs: ConnectTab[];
  initialId: string;
  title: string;
  tablistLabel: string;
  moreLabel: string;
  /** The paid-plan note, shown above the steps on every tab. */
  banner: React.ReactNode;
}) {
  const uid = useId();
  const [active, setActive] = useState(tabs.some((t) => t.id === initialId) ? initialId : tabs[0].id);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const track = useRef<HTMLDivElement>(null);
  // Which side of the strip still has pills (phone only; CSS draws a soft edge there).
  const [edge, setEdge] = useState<"none" | "start" | "mid" | "end">("none");

  function measureEdge() {
    const box = track.current;
    if (!box) return;
    const max = box.scrollWidth - box.clientWidth;
    if (max <= 1) return setEdge("none");
    const x = box.scrollLeft;
    setEdge(x <= 2 ? "start" : x >= max - 2 ? "end" : "mid");
  }

  function reveal(id: string, smooth: boolean) {
    const pill = refs.current[id];
    const box = track.current;
    if (!pill || !box || box.scrollWidth <= box.clientWidth) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo({ left: pill.offsetLeft - (box.clientWidth - pill.offsetWidth) / 2, behavior: smooth && !reduce ? "smooth" : "auto" });
  }

  function writeUrl(id: string) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", id);
      url.hash = "";
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* a sandboxed frame may refuse; the tab still changes */
    }
  }

  useEffect(() => {
    // An old `#cursor` link still works; it becomes `?tab=cursor`.
    let fromHash = "";
    try {
      fromHash = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      /* a malformed escape such as #% is not a tab id; it must not take the page down */
    }
    const id = tabs.some((t) => t.id === fromHash) ? fromHash : active;
    if (id !== active) {
      setActive(id);
      writeUrl(id);
    }
    reveal(id, false);
    measureEdge();
    window.addEventListener("resize", measureEdge);
    return () => window.removeEventListener("resize", measureEdge);
    // Once, on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function choose(id: string, focus = false) {
    setActive(id);
    writeUrl(id);
    if (focus) refs.current[id]?.focus();
    reveal(id, true);
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

  const firstMore = tabs.findIndex((t) => t.group === "more");

  return (
    <div className="st-cc" id="connect">
      <noscript>
        <style>{`.st-tabpanels{display:block!important}.st-tabpanel{display:block!important;visibility:visible!important;opacity:1!important;margin-bottom:16px}.st-pilltrack{display:none!important}`}</style>
      </noscript>
      <h2 className="sr-only">{title}</h2>
      <div className="st-pilltrack-wrap" ref={track} data-edge={edge} onScroll={measureEdge}>
        <div role="tablist" aria-label={tablistLabel} className="st-pilltrack">
          {tabs.map((t, i) => (
            <span key={t.id} className="st-pill-slot" role="presentation">
              {i === firstMore && firstMore > 0 && (
                <span className="st-pill-more" aria-hidden>
                  {moreLabel}
                </span>
              )}
              <button
                ref={(el) => {
                  refs.current[t.id] = el;
                }}
                type="button"
                role="tab"
                id={`${uid}-tab-${t.id}`}
                aria-selected={t.id === active}
                aria-controls={`${uid}-panel-${t.id}`}
                tabIndex={t.id === active ? 0 : -1}
                className="st-pill"
                data-id={t.id}
                onClick={() => choose(t.id)}
                onKeyDown={(e) => onKey(e, i)}
              >
                <span className="st-pill-glyph" data-tile={t.tile} aria-hidden>
                  {t.glyph}
                </span>
                <span className="st-pill-label">{t.label}</span>
              </button>
            </span>
          ))}
        </div>
      </div>
      <div className="st-banner">{banner}</div>
      <div className="st-tabpanels">
        {tabs.map((t) => (
          <div
            key={t.id}
            role="tabpanel"
            id={`${uid}-panel-${t.id}`}
            aria-labelledby={`${uid}-tab-${t.id}`}
            data-active={t.id === active}
            data-group={t.group}
            className="st-tabpanel"
          >
            {t.soon ? (
              <div className="st-soon">
                <span className="st-soon-badge">{t.soon.badge}</span>
                <h3 className="st-soon-title">{t.soon.title}</h3>
                <p className="st-body">{t.soon.body}</p>
                <p className="st-small">{t.soon.use}</p>
                <div className="st-soon-go">
                  {t.soon.goto.map((g) => (
                    <button key={g.id} type="button" className="st-key" data-size="sm" data-tone="quiet" onClick={() => choose(g.id, true)}>
                      {g.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              t.panel
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
