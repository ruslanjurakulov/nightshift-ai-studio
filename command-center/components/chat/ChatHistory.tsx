"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, MoreHorizontal, PanelLeftClose, PanelLeftOpen, SquarePen, X } from "lucide-react";
import "./chat-history.css";

/**
 * The chat shell's history panel: "New chat", the stored conversations newest first, rename and delete. It is shared (the owner's
 * console now, the customer's Nightshift AI next), so it never fetches by itself: the caller hands it a source that talks to that
 * product's own server route. The panel owns the list; the caller owns the thread (opening a session loads it into the chat).
 *
 * Desktop: a 268px column that collapses (remembered per product in localStorage). Phone: a drawer from the left, opened by the
 * header's menu button, closed on a pick, an outside tap or Esc, with focus kept inside while it is open.
 */

export interface ChatSessionItem {
  id: string;
  title: string;
  updatedAt: string;
}

/** gone: the session no longer exists for this person (deleted on another device); the row is dropped, not retried. */
export type HistoryResult<T> = { ok: true; value: T } | { ok: false; gone?: boolean; message: string };

export interface ChatHistorySource {
  list(before: string | null): Promise<HistoryResult<{ items: ChatSessionItem[]; nextBefore: string | null }>>;
  rename(id: string, title: string): Promise<HistoryResult<null>>;
  remove(id: string): Promise<HistoryResult<null>>;
}

export interface ChatHistoryLabels {
  heading: string;
  newChat: string;
  loading: string;
  empty: string;
  error: string;
  retry: string;
  more: string;
  /** "{title}" is replaced: the row's menu button. */
  options: string;
  rename: string;
  renameLabel: string;
  save: string;
  cancel: string;
  delete: string;
  confirmDelete: string;
  confirmDeleteBody: string;
  gone: string;
  untitled: string;
  open: string;
  close: string;
  collapse: string;
  expand: string;
  /** Relative times come from the dictionary, not Intl: browsers have no (or partial) "uz" data and fell back to English with a minus sign. */
  justNow: string;
  /** "{n}" is replaced in the three below. */
  minutesAgo: string;
  hoursAgo: string;
  yesterday: string;
  daysAgo: string;
  /** Twelve short month names, January first, for the date shown once a chat is a week old. */
  months: readonly string[];
}

const TITLE_MAX = 60;

export function relativeTime(iso: string, l: ChatHistoryLabels, now = Date.now()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  // A stamp slightly ahead of this clock (skew) is "just now", never a negative count.
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return l.justNow;
  if (s < 3600) return l.minutesAgo.replace("{n}", String(Math.floor(s / 60)));
  if (s < 86400) return l.hoursAgo.replace("{n}", String(Math.floor(s / 3600)));
  if (s < 2 * 86400) return l.yesterday;
  if (s < 7 * 86400) return l.daysAgo.replace("{n}", String(Math.floor(s / 86400)));
  const d = new Date(ms);
  return `${d.getDate()} ${l.months[d.getMonth()] ?? ""}`.trim();
}

function readCollapsed(key: string): boolean {
  // Private mode and blocked storage throw on access: the panel then simply starts open.
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeCollapsed(key: string, v: boolean) {
  try {
    window.localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* not remembered; the toggle still works for this page */
  }
}

const focusables = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));

export function ChatHistoryFrame({
  labels: l,
  source,
  storageKey,
  activeId,
  busy,
  reloadKey,
  onSelect,
  onNewChat,
  onRemoved,
  renderChat,
}: {
  labels: ChatHistoryLabels;
  source: ChatHistorySource;
  storageKey: string;
  activeId: string | null;
  /** An answer is on its way: switching chats now would draw it into the wrong one. */
  busy: boolean;
  /** Bumped by the caller when a turn created a session, so the list shows it. */
  reloadKey: number;
  onSelect: (id: string) => Promise<HistoryResult<null>>;
  onNewChat: () => void;
  onRemoved: (id: string) => void;
  /** The chat, given the header button that opens the drawer (phone) or the collapsed panel (desktop). */
  renderChat: (lead: ReactNode) => ReactNode;
}) {
  const [items, setItems] = useState<ChatSessionItem[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const aside = useRef<HTMLElement>(null);
  const lead = useRef<HTMLButtonElement>(null);
  const seq = useRef(0);

  useEffect(() => setCollapsed(readCollapsed(storageKey)), [storageKey]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setState((s) => (s === "ready" ? s : "loading"));
    const r = await source.list(null);
    if (mine !== seq.current) return;
    if (!r.ok) {
      setLoadError(r.message);
      setState("error");
      return;
    }
    setItems(r.value.items);
    setNext(r.value.nextBefore);
    setLoadError(null);
    setState("ready");
  }, [source]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  async function loadMore() {
    if (!next || more) return;
    setMore(true);
    const r = await source.list(next);
    setMore(false);
    if (!r.ok) {
      setNotice(r.message);
      return;
    }
    setItems((prev) => [...prev, ...r.value.items.filter((i) => !prev.some((p) => p.id === i.id))]);
    setNext(r.value.nextBefore);
  }

  const closeDrawer = useCallback(() => {
    setOpen(false);
    lead.current?.focus();
  }, []);

  // Phone drawer: Esc closes it and Tab stays inside it (it covers the chat, so focus behind it would be lost to the eye).
  useEffect(() => {
    if (!open) return;
    const root = aside.current;
    if (root) focusables(root)[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeDrawer();
        return;
      }
      if (e.key !== "Tab" || !root) return;
      const f = focusables(root);
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, closeDrawer]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest?.("[data-history-menu]")) setMenu(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [menu]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      writeCollapsed(storageKey, !c);
      return !c;
    });
  }

  async function select(id: string) {
    if (busy) return;
    setNotice(null);
    if (open) setOpen(false);
    const r = await onSelect(id);
    if (!r.ok) {
      if (r.gone) {
        setItems((prev) => prev.filter((i) => i.id !== id));
        setNotice(l.gone);
      } else setNotice(r.message);
    }
  }

  async function saveRename() {
    if (!editing) return;
    const title = editing.value.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
    const before = items.find((i) => i.id === editing.id);
    setEditing(null);
    if (!before || !title || title === before.title) return;
    setNotice(null);
    setItems((prev) => prev.map((i) => (i.id === before.id ? { ...i, title } : i)));
    const r = await source.rename(before.id, title);
    if (r.ok) return;
    if (r.gone) {
      setItems((prev) => prev.filter((i) => i.id !== before.id));
      setNotice(l.gone);
      onRemoved(before.id);
      return;
    }
    // The rename did not land: the old title comes back, with the reason, rather than a title the database does not have.
    setItems((prev) => prev.map((i) => (i.id === before.id ? { ...i, title: before.title } : i)));
    setNotice(r.message);
  }

  async function confirmDelete() {
    const id = confirm;
    setConfirm(null);
    if (!id) return;
    const index = items.findIndex((i) => i.id === id);
    const row = items[index];
    if (!row) return;
    setNotice(null);
    setItems((prev) => prev.filter((i) => i.id !== id));
    const r = await source.remove(id);
    if (r.ok || r.gone) {
      onRemoved(id);
      return;
    }
    setItems((prev) => {
      const copy = prev.filter((i) => i.id !== id);
      copy.splice(Math.min(index, copy.length), 0, row);
      return copy;
    });
    setNotice(r.message);
  }

  const leadButton = (
    <button
      ref={lead}
      type="button"
      className="chat-act chat-history-lead"
      aria-label={l.open}
      data-tip={l.open}
      aria-expanded={open}
      aria-controls="chat-history"
      onClick={() => setOpen(true)}
    >
      <Menu aria-hidden size={18} />
    </button>
  );

  const confirming = confirm ? items.find((i) => i.id === confirm) : null;

  return (
    <div className="chat-frame" data-collapsed={collapsed || undefined} data-open={open || undefined}>
      {open && <div className="chat-history-scrim" data-testid="history-scrim" aria-hidden onClick={closeDrawer} />}
      <aside
        id="chat-history"
        ref={aside}
        className="chat-history"
        aria-label={l.heading}
        {...(open ? { role: "dialog", "aria-modal": true } : {})}
      >
        <div className="chat-history-top">
          <button
            type="button"
            className="chat-history-new"
            disabled={busy}
            onClick={() => {
              onNewChat();
              if (open) closeDrawer();
            }}
          >
            <SquarePen aria-hidden size={16} />
            <span>{l.newChat}</span>
          </button>
          <button type="button" className="chat-act chat-history-collapse" aria-label={l.collapse} data-tip={l.collapse} onClick={toggleCollapsed}>
            <PanelLeftClose aria-hidden size={18} />
          </button>
          <button type="button" className="chat-act chat-history-close" aria-label={l.close} data-tip={l.close} onClick={closeDrawer}>
            <X aria-hidden size={18} />
          </button>
        </div>
        <h2 className="chat-history-heading">{l.heading}</h2>
        {notice && (
          <p className="chat-history-notice" role="alert">
            {notice}
          </p>
        )}
        {state === "loading" ? (
          <ul className="chat-history-list" aria-busy="true" aria-label={l.loading}>
            {[0, 1, 2, 3, 4].map((k) => (
              <li key={k} className="chat-history-skel" />
            ))}
          </ul>
        ) : state === "error" ? (
          <div className="chat-history-error" role="alert">
            <p>{loadError ?? l.error}</p>
            <button type="button" className="btn-quiet" onClick={() => void load()}>
              {l.retry}
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="chat-history-empty">{l.empty}</p>
        ) : (
          <ul className="chat-history-list">
            {items.map((i) => {
              const title = i.title || l.untitled;
              return (
                <li key={i.id} className="chat-history-row" data-active={i.id === activeId || undefined}>
                  {editing?.id === i.id ? (
                    <form
                      className="chat-history-edit"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void saveRename();
                      }}
                    >
                      <input
                        autoFocus
                        aria-label={l.renameLabel}
                        maxLength={TITLE_MAX}
                        value={editing.value}
                        onChange={(e) => setEditing({ id: i.id, value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            e.stopPropagation();
                            setEditing(null);
                          }
                        }}
                      />
                      <button type="submit" className="btn-quiet">
                        {l.save}
                      </button>
                      <button type="button" className="btn-quiet" onClick={() => setEditing(null)}>
                        {l.cancel}
                      </button>
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="chat-history-item"
                        aria-current={i.id === activeId ? "true" : undefined}
                        disabled={busy}
                        onClick={() => void select(i.id)}
                      >
                        <span className="chat-history-title">{title}</span>
                        <time className="chat-history-time" dateTime={i.updatedAt}>
                          {relativeTime(i.updatedAt, l)}
                        </time>
                      </button>
                      <div className="chat-history-menu" data-history-menu>
                        <button
                          type="button"
                          className="chat-act"
                          aria-label={l.options.replace("{title}", title)}
                          aria-haspopup="menu"
                          aria-expanded={menu === i.id}
                          onClick={() => setMenu((m) => (m === i.id ? null : i.id))}
                        >
                          <MoreHorizontal aria-hidden size={16} />
                        </button>
                        {menu === i.id && (
                          <div role="menu" className="chat-history-pop">
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMenu(null);
                                setEditing({ id: i.id, value: i.title });
                              }}
                            >
                              {l.rename}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              data-tone="danger"
                              onClick={() => {
                                setMenu(null);
                                setConfirm(i.id);
                              }}
                            >
                              {l.delete}
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {state === "ready" && next && (
          <button type="button" className="btn-quiet chat-history-more" disabled={more} onClick={() => void loadMore()}>
            {more ? l.loading : l.more}
          </button>
        )}
        {confirming && (
          <div className="chat-history-confirm" role="alertdialog" aria-labelledby="chat-history-confirm-t" aria-describedby="chat-history-confirm-b">
            <p id="chat-history-confirm-t" className="chat-history-confirm-title">
              {l.confirmDelete}
            </p>
            <p id="chat-history-confirm-b">{l.confirmDeleteBody.replace("{title}", confirming.title || l.untitled)}</p>
            <div className="chat-history-confirm-acts">
              <button type="button" className="btn-quiet" autoFocus onClick={() => setConfirm(null)}>
                {l.cancel}
              </button>
              <button type="button" className="btn-quiet" data-tone="danger" onClick={() => void confirmDelete()}>
                {l.delete}
              </button>
            </div>
          </div>
        )}
      </aside>
      <div className="chat-frame-main">
        {collapsed && (
          <button type="button" className="chat-act chat-history-expand" aria-label={l.expand} data-tip={l.expand} onClick={toggleCollapsed}>
            <PanelLeftOpen aria-hidden size={18} />
          </button>
        )}
        {renderChat(leadButton)}
      </div>
    </div>
  );
}
