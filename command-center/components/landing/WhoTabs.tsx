"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { ArrowRight, Film, Palette, Sparkles, type LucideIcon } from "lucide-react";
import type { Dictionary } from "@/lib/i18n";
import { isSolutionId, solutionHref } from "@/lib/solutions";

const ICON: Record<string, LucideIcon> = { "youtube-channels": Film, "creative-studio": Palette, developers: Sparkles };

/**
 * "Who it is for" as tabs: pick the work you do, read what Nightshift does for
 * it, where to start and the one thing it will not do. Every word comes from
 * the Solutions pages' own copy (site.solutions.pages), so this cannot say
 * something those pages do not, and the link goes to the full page.
 *
 * All panels are in the HTML and share one grid cell (the tallest sets the
 * height), inactive ones are inert, tabs are a roving-tabindex tablist with
 * arrow, Home and End keys. Nothing moves on its own.
 *
 * It takes the two slices of copy it reads, never the whole dictionary: a
 * client component's props travel in the page's HTML, and the whole dictionary
 * is hundreds of kilobytes.
 */
export type WhoPage = { id: string; kicker: string; title: string; lead: string; start: readonly string[]; not: readonly string[] };
export type WhoSolutions = { pages: readonly WhoPage[]; open: string; startLabel: string; notLabel: string };

export function WhoTabs({ who: w, solutions: sol }: { who: Dictionary["site"]["who"]; solutions: WhoSolutions }) {
  const uid = useId();
  const items = w.items.filter((i) => isSolutionId(i.id));
  const [active, setActive] = useState(0);

  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    const last = items.length - 1;
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (to < 0) return;
    e.preventDefault();
    setActive(to);
    document.getElementById(`${uid}-tab-${to}`)?.focus();
  };

  return (
    <div className="nx-who">
      <div role="tablist" aria-label={w.tabsLabel} className="nx-who-tabs">
        {items.map((item, i) => {
          const Icon = ICON[item.id] ?? Film;
          return (
            <button
              key={item.id}
              id={`${uid}-tab-${i}`}
              type="button"
              role="tab"
              aria-selected={i === active}
              aria-controls={`${uid}-panel-${i}`}
              tabIndex={i === active ? 0 : -1}
              className="nx-who-tab"
              onClick={() => setActive(i)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <span className="nx-who-ico" aria-hidden>
                <Icon />
              </span>
              <span className="nx-who-name">{item.title}</span>
              <span className="nx-who-body">{item.body}</span>
            </button>
          );
        })}
      </div>
      <div className="nx-who-panels">
        {items.map((item, i) => {
          const page = sol.pages.find((p) => p.id === item.id);
          if (!page || !isSolutionId(item.id)) return null;
          const on = i === active;
          return (
            <div
              key={item.id}
              id={`${uid}-panel-${i}`}
              role="tabpanel"
              aria-labelledby={`${uid}-tab-${i}`}
              className="nx-who-panel"
              data-on={on ? "true" : "false"}
              inert={on ? undefined : true}
              aria-hidden={on ? undefined : true}
              data-spot
            >
              <div className="nx-who-words">
                <p className="nx-kicker">{page.kicker}</p>
                <h3 className="nx-h3 nx-who-h">{page.title}</h3>
                <p className="nx-body">{page.lead}</p>
                <Link href={solutionHref(item.id)} className="nx-link" tabIndex={on ? 0 : -1}>
                  {sol.open}
                  <ArrowRight aria-hidden />
                </Link>
              </div>
              <div className="nx-who-side">
                <p className="nx-kicker">{sol.startLabel}</p>
                <ol className="nx-who-steps">
                  {page.start.map((s, k) => (
                    <li key={s}>
                      <span className="nx-step-no" aria-hidden>
                        {k + 1}
                      </span>
                      {s}
                    </li>
                  ))}
                </ol>
                <p className="nx-kicker nx-who-not-k">{sol.notLabel}</p>
                <p className="nx-who-not">{page.not[0]}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
