"use client";

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, ChevronDown } from "lucide-react";
import { isCurrentPage, menuHref } from "@/lib/public-menu-href";
import type { NavEntry, NavGroup, NavGroupId, PublicSection } from "@/lib/public-nav";

/**
 * Hover intent: a pointer passing across the bar on its way to the page must not flash a panel open, so a trigger opens
 * only after the pointer has rested on it this long. Once a panel is open, moving to another trigger switches at once.
 */
export const OPEN_DELAY_MS = 120;
/**
 * The way from a trigger down to its panel crosses the bar's empty strip under the trigger (and, on a diagonal, a bit of
 * the row beside it). Leaving the trigger starts this timer; entering the panel cancels it, so the travel never closes it.
 */
export const CLOSE_DELAY_MS = 150;
/** A pointer that can hover. On a touch screen a tap is a click, and a hover-open would fight it. */
const HOVER = "(hover: hover) and (pointer: fine)";
/** Below this the bar is the phone bar and the panels' content is in the sheet (components/legal/PublicMenu.tsx). */
const DESK = "(min-width: 768px)";

type OpenedBy = "hover" | "click" | "key";
type FocusRequest = { id: NavGroupId; where: "first" | "last" } | null;

interface MenuState {
  groups: NavGroup[];
  entries: NavEntry[];
  current: PublicSection;
  pathname: string;
  openId: NavGroupId | null;
  /** The last panel opened: kept drawn while the frame fades out, so closing does not blank it first. */
  shownId: NavGroupId | null;
  ids: (id: NavGroupId) => { trigger: string; panel: string };
  triggers: React.MutableRefObject<Map<NavGroupId, HTMLButtonElement>>;
  nav: React.RefObject<HTMLElement | null>;
  frame: React.RefObject<HTMLDivElement | null>;
  open: (id: NavGroupId, by: OpenedBy, focus?: "first" | "last") => void;
  close: (returnFocus: boolean) => void;
  toggle: (id: NavGroupId, by: OpenedBy) => void;
  hoverEnter: (id: NavGroupId, e: React.PointerEvent) => void;
  hoverLeave: (e: React.PointerEvent) => void;
  frameEnter: () => void;
}

const Ctx = createContext<MenuState | null>(null);

function useMenu(): MenuState {
  const v = useContext(Ctx);
  if (!v) throw new Error("PublicMegaMenu parts must sit inside <MegaMenu>");
  return v;
}

const canHover = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(HOVER).matches;

/**
 * The public header's desktop panels: a disclosure per trigger (a <button> with aria-expanded and aria-controls, not
 * role="menu": the panels hold ordinary links, and a menu role would take Tab and the screen reader's browse mode away).
 *
 * The provider holds the one open panel; <MegaNav> draws the triggers in the bar's row and <MegaPanels> the frame under the
 * bar, as a child of the header itself, so the frame spans the header's full width and overlays the page without moving it.
 * Only one panel is open at a time.
 */
export function MegaMenu({ entries, current, children }: { entries: NavEntry[]; current: PublicSection; children: React.ReactNode }) {
  const groups = useMemo(() => entries.filter((e): e is NavGroup => e.kind === "group"), [entries]);
  const pathname = usePathname() ?? "";
  const uid = useId();
  const [openId, setOpenId] = useState<NavGroupId | null>(null);
  const [shownId, setShownId] = useState<NavGroupId | null>(null);
  const [focusReq, setFocusReq] = useState<FocusRequest>(null);
  const openedBy = useRef<OpenedBy>("click");
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const triggers = useRef(new Map<NavGroupId, HTMLButtonElement>());
  const nav = useRef<HTMLElement | null>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const openRef = useRef<NavGroupId | null>(null);
  openRef.current = openId;

  const ids = useCallback(
    (id: NavGroupId) => ({
      trigger: `${uid}-${id}-t`,
      panel: `${uid}-${id}-p`,
    }),
    [uid],
  );

  const clearTimers = useCallback(() => {
    clearTimeout(openTimer.current);
    clearTimeout(closeTimer.current);
  }, []);

  const open = useCallback(
    (id: NavGroupId, by: OpenedBy, focus?: "first" | "last") => {
      clearTimers();
      openedBy.current = by;
      setOpenId(id);
      setShownId(id);
      if (focus) setFocusReq({ id, where: focus });
    },
    [clearTimers],
  );

  const close = useCallback(
    (returnFocus: boolean) => {
      clearTimers();
      const was = openRef.current;
      setOpenId(null);
      if (returnFocus && was) triggers.current.get(was)?.focus();
    },
    [clearTimers],
  );

  const toggle = useCallback(
    (id: NavGroupId, by: OpenedBy) => {
      if (openRef.current === id) {
        // The pointer rested, the panel opened, and then the visitor clicked the trigger they were already on: that
        // click means "this one", not "close it". It pins the panel instead (leaving the trigger no longer closes it).
        if (by === "click" && openedBy.current === "hover") {
          clearTimers();
          openedBy.current = "click";
          return;
        }
        close(false);
        return;
      }
      open(id, by);
    },
    [clearTimers, close, open],
  );

  const hoverEnter = useCallback(
    (id: NavGroupId, e: React.PointerEvent) => {
      if (e.pointerType === "touch" || !canHover()) return;
      clearTimeout(closeTimer.current);
      if (openRef.current) {
        // Switching from one open panel to the next is instant: the visitor is already reading the menu.
        if (openRef.current !== id) open(id, "hover");
        return;
      }
      clearTimeout(openTimer.current);
      openTimer.current = setTimeout(() => open(id, "hover"), OPEN_DELAY_MS);
    },
    [open],
  );

  const hoverLeave = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === "touch") return;
      clearTimeout(openTimer.current);
      // A panel the visitor clicked or opened from the keyboard stays until they close it, click away or tab away.
      if (!openRef.current || openedBy.current !== "hover") return;
      clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => close(false), CLOSE_DELAY_MS);
    },
    [close],
  );

  const frameEnter = useCallback(() => clearTimeout(closeTimer.current), []);

  // A route change (a link in a panel, the back button) leaves no panel open over the new page.
  useEffect(() => {
    setOpenId(null);
  }, [pathname]);

  useEffect(() => clearTimers, [clearTimers]);

  // Focus moves into a panel only after it is drawn: a hidden link cannot take focus.
  useLayoutEffect(() => {
    if (!focusReq || openId !== focusReq.id) return;
    const items = panelItems(document.getElementById(ids(focusReq.id).panel));
    (focusReq.where === "first" ? items[0] : items[items.length - 1])?.focus();
    setFocusReq(null);
  }, [focusReq, openId, ids]);

  useEffect(() => {
    if (!openId) return;
    const inside = (n: EventTarget | null) => n instanceof Node && Boolean(nav.current?.contains(n) || frame.current?.contains(n));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The language list (a listbox in the same header) closes itself first.
      if (document.querySelector('.st-header [aria-haspopup="listbox"][aria-expanded="true"]')) return;
      e.preventDefault();
      // Focus goes back to the trigger when it was in the menu; a panel opened by hovering leaves focus where it was.
      close(inside(document.activeElement));
    };
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target)) close(false);
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!inside(e.target)) {
        close(false);
        return;
      }
      // Focus on another item of the bar (Shift+Tab back out of a panel past its trigger, or a click on Pricing): the open
      // panel is no longer the one being read. Its own trigger and its own links keep it open.
      const t = e.target as Node;
      const own = triggers.current.get(openId);
      if (nav.current?.contains(t) && t !== own) close(false);
    };
    const desk = typeof window.matchMedia === "function" ? window.matchMedia(DESK) : null;
    const onNarrow = () => {
      if (desk && !desk.matches) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("focusin", onFocusIn);
    desk?.addEventListener?.("change", onNarrow);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("focusin", onFocusIn);
      desk?.removeEventListener?.("change", onNarrow);
    };
  }, [openId, close]);

  // Memoised: every trigger, panel and the frame read this context, and a fresh object each render re-rendered them all
  // on any parent render.
  const value = useMemo<MenuState>(
    () => ({
      groups,
      entries,
      current,
      pathname,
      openId,
      shownId,
      ids,
      triggers,
      nav,
      frame,
      open,
      close,
      toggle,
      hoverEnter,
      hoverLeave,
      frameEnter,
    }),
    [groups, entries, current, pathname, openId, shownId, ids, open, close, toggle, hoverEnter, hoverLeave, frameEnter],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** A panel's links, by column, in reading order. */
function panelColumns(panel: Element | null): HTMLElement[][] {
  if (!panel) return [];
  return [...panel.querySelectorAll<HTMLElement>(".st-mm-col")].map((c) => [...c.querySelectorAll<HTMLElement>("a[href]")]);
}
function panelItems(panel: Element | null): HTMLElement[] {
  return panelColumns(panel).flat();
}

/** The bar's items in order: the triggers and the plain links (Pricing). */
function barItems(nav: HTMLElement | null): HTMLElement[] {
  return nav ? [...nav.querySelectorAll<HTMLElement>(":scope > a[href], :scope > button")] : [];
}

/** The triggers and plain links of the bar, inside the header's row (the nav landmark and its order are the shell's). */
export function MegaNav({ label }: { label: string }) {
  const m = useMenu();
  const setNav = useCallback(
    (el: HTMLElement | null) => {
      m.nav.current = el;
    },
    [m.nav],
  );

  const moveInBar = (from: HTMLElement, step: 1 | -1) => {
    const items = barItems(m.nav.current);
    const at = items.indexOf(from);
    const next = items[(at + step + items.length) % items.length];
    if (!next) return;
    next.focus();
    // With a panel open, the arrow carries it along: the next trigger's panel opens, a plain link closes it.
    if (m.openId) {
      const id = next.getAttribute("data-mm") as NavGroupId | null;
      if (id) m.open(id, "key");
      else m.close(false);
    }
  };

  return (
    <nav ref={setNav} aria-label={label} className="st-nav">
      {m.entries.map((e) => {
        if (e.kind === "link") {
          return (
            <Link
              key={e.href}
              href={menuHref(e.href)}
              aria-current={e.section && e.section === m.current ? "page" : undefined}
              onKeyDown={(ev) => {
                if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
                  ev.preventDefault();
                  moveInBar(ev.currentTarget, ev.key === "ArrowRight" ? 1 : -1);
                }
              }}
            >
              {e.label}
            </Link>
          );
        }
        const { trigger, panel } = m.ids(e.id);
        const expanded = m.openId === e.id;
        return (
          <button
            key={e.id}
            ref={(el) => {
              if (el) m.triggers.current.set(e.id, el);
              else m.triggers.current.delete(e.id);
            }}
            id={trigger}
            type="button"
            className="st-mm-trigger"
            data-mm={e.id}
            data-current={e.section && e.section === m.current ? "true" : undefined}
            // The group holding this page: "true", not "page" (the trigger is not the page itself).
            aria-current={e.section && e.section === m.current ? "true" : undefined}
            aria-expanded={expanded}
            aria-controls={panel}
            // Enter and Space are the button's own: the browser turns them into this click (Space on keyup, which a keydown
            // preventDefault does not cancel in every browser, so handling the keys as well toggled twice). A click with no
            // pointer behind it (detail 0: a key, or a screen reader) counts as the keyboard's, so leaving with the pointer
            // never closes it; focus stays on the trigger (a disclosure), and ArrowDown or Tab goes in.
            onClick={(ev) => m.toggle(e.id, ev.detail === 0 ? "key" : "click")}
            onPointerEnter={(ev) => m.hoverEnter(e.id, ev)}
            onPointerLeave={m.hoverLeave}
            onKeyDown={(ev) => {
              // A held arrow repeats keydown: it opens the panel once, not over and over.
              if (ev.repeat && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
                ev.preventDefault();
                return;
              }
              switch (ev.key) {
                case "ArrowDown":
                  ev.preventDefault();
                  m.open(e.id, "key", "first");
                  return;
                case "ArrowUp":
                  ev.preventDefault();
                  m.open(e.id, "key", "last");
                  return;
                case "ArrowRight":
                case "ArrowLeft":
                  ev.preventDefault();
                  moveInBar(ev.currentTarget, ev.key === "ArrowRight" ? 1 : -1);
                  return;
                case "Tab":
                  // The panel is drawn after the whole row (it spans the header), so the natural next stop would be the
                  // next trigger: with this panel open, Tab goes into it first, as if it followed its trigger.
                  if (!ev.shiftKey && expanded) {
                    const first = panelItems(document.getElementById(panel))[0];
                    if (first) {
                      ev.preventDefault();
                      first.focus();
                    }
                  }
                  return;
              }
            }}
          >
            {e.label}
            <ChevronDown aria-hidden className="st-mm-chev" />
          </button>
        );
      })}
      {/* Without JavaScript a trigger opens nothing: each group's first page is linked instead (the noscript rule in the shell
          hides the triggers). */}
      <noscript>
        {m.groups.map((g) => {
          const c = g.columns[0];
          const href = c?.href ?? c?.links[0]?.href;
          return href ? (
            <a key={g.id} href={menuHref(href)} className="st-mm-nojs">
              {g.label}
            </a>
          ) : null;
        })}
      </noscript>
    </nav>
  );
}

/** The frame under the bar and every panel in it; only the open (or closing) one is drawn. */
export function MegaPanels() {
  const m = useMenu();
  const inner = useRef<HTMLDivElement>(null);
  const isOpen = m.openId !== null;

  // A one-column panel starts under its trigger (the reference layout); measured on open, kept inside the page column.
  useLayoutEffect(() => {
    const id = m.openId;
    const box = inner.current;
    if (!id || !box) return;
    const t = m.triggers.current.get(id);
    if (!t) return;
    const col = box.querySelector<HTMLElement>(`[data-panel="${id}"] .st-mm-col`);
    // The panel sits inside the page column's padding (.st-wrap's gutter): measured from the content edge, not the box's, or a
    // one-column panel started a gutter's width to the right of its trigger.
    const cs = getComputedStyle(box);
    const padL = parseFloat(cs.paddingLeft) || 0;
    const padR = parseFloat(cs.paddingRight) || 0;
    const room = box.clientWidth - padL - padR - (col?.offsetWidth ?? 0);
    const x = Math.round(t.getBoundingClientRect().left - box.getBoundingClientRect().left - padL);
    box.style.setProperty("--mm-x", `${Math.max(0, Math.min(x, room))}px`);
  }, [m.openId, m.triggers]);

  const setFrame = useCallback(
    (el: HTMLDivElement | null) => {
      m.frame.current = el;
    },
    [m.frame],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const id = m.openId;
    if (!id) return;
    const panel = document.getElementById(m.ids(id).panel);
    const cols = panelColumns(panel);
    const all = cols.flat();
    const a = document.activeElement as HTMLElement | null;
    const ci = cols.findIndex((c) => a !== null && c.includes(a));
    if (ci < 0 || !a) return;
    const ri = cols[ci].indexOf(a);
    const trigger = m.triggers.current.get(id);
    const go = (el: HTMLElement | undefined) => {
      if (!el) return;
      e.preventDefault();
      el.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        go(cols[ci][ri + 1]);
        return;
      case "ArrowUp":
        // Up from the first link goes back to the trigger, the way it came in.
        go(ri === 0 ? trigger : cols[ci][ri - 1]);
        return;
      case "ArrowRight":
      case "ArrowLeft": {
        const nc = cols[ci + (e.key === "ArrowRight" ? 1 : -1)];
        if (nc) go(nc[Math.min(ri, nc.length - 1)]);
        return;
      }
      case "Home":
        go(all[0]);
        return;
      case "End":
        go(all[all.length - 1]);
        return;
      case "Tab": {
        if (e.shiftKey && a === all[0]) {
          go(trigger);
          return;
        }
        if (!e.shiftKey && a === all[all.length - 1] && trigger) {
          // Out of the last link: on to whatever follows the trigger in the bar, and the panel closes behind.
          const next = afterTrigger(trigger, m.nav.current);
          if (next) {
            e.preventDefault();
            m.close(false);
            next.focus();
          }
        }
        return;
      }
    }
  };

  return (
    <div
      ref={setFrame}
      className="st-mm"
      data-open={isOpen ? "true" : "false"}
      inert={!isOpen}
      onPointerEnter={m.frameEnter}
      onPointerLeave={m.hoverLeave}
      onKeyDown={onKeyDown}
    >
      <div ref={inner} className="st-wrap st-mm-inner">
        {m.groups.map((g) => (
          <Panel key={g.id} group={g} shown={m.shownId === g.id} />
        ))}
      </div>
    </div>
  );
}

function Panel({ group, shown }: { group: NavGroup; shown: boolean }) {
  const m = useMenu();
  const { trigger, panel } = m.ids(group.id);
  return (
    <div id={panel} data-panel={group.id} className="st-mm-panel" role="group" aria-labelledby={trigger} hidden={!shown}>
      {group.columns.map((c) => {
        const titleId = `${panel}-${c.id}`;
        return (
          <div key={c.id} className="st-mm-col">
            {c.href ? (
              <Link
                id={titleId}
                href={menuHref(c.href)}
                className="st-mm-title"
                data-link="true"
                aria-current={isCurrentPage(c.href, m.pathname) ? "page" : undefined}
                // A link to this same page (or a #section of it) changes no pathname, so the route-change close never
                // runs: the panel would stay open over the section it just scrolled to.
                onClick={() => m.close(false)}
              >
                {c.title}
                <ArrowRight aria-hidden />
              </Link>
            ) : (
              <p id={titleId} className="st-mm-title">
                {c.title}
              </p>
            )}
            <ul aria-labelledby={titleId}>
              {c.links.map((l) => (
                <li key={l.href}>
                  <Link
                    href={menuHref(l.href)}
                    className="st-mm-link"
                    aria-current={isCurrentPage(l.href, m.pathname) ? "page" : undefined}
                    onClick={() => m.close(false)}
                  >
                    <span className="st-mm-label">{l.label}</span>
                    {l.description && <span className="st-mm-desc">{l.description}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** What Tab reaches after a trigger, skipping its panel: the next item of the bar, else the first control after the nav. */
function afterTrigger(trigger: HTMLElement, nav: HTMLElement | null): HTMLElement | null {
  const items = barItems(nav);
  const at = items.indexOf(trigger);
  if (at >= 0 && at < items.length - 1) return items[at + 1];
  const header = trigger.closest("header");
  if (!header || !nav) return null;
  const after = [...header.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
    (el) =>
      !nav.contains(el) &&
      !el.closest(".st-mm, .st-menu-root") &&
      Boolean(nav.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
  );
  // Only what is drawn (the phone's menu button is in the DOM at every width); jsdom draws nothing, so then the first.
  const drawn = after.filter((el) => el.getClientRects().length > 0);
  return (drawn.length > 0 ? drawn : after)[0] ?? null;
}
