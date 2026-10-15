"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { fmt, LOCALES } from "@/lib/i18n/core";
import { useToast } from "@/components/feedback/ToastProvider";
import {
  CHANNEL_EVENTS,
  isChannelError,
  parseChannels,
  parsePreferences,
  type ChannelAction,
  type ChannelError,
  type ChannelRow,
  type PreferenceRow,
} from "@/lib/notify-channels";

const POLL_MS = 3000;

/**
 * Settings → Notifications: link a Telegram chat, choose which events go there,
 * pause, test, disconnect. Every change is a request to /api/notifications/telegram
 * (the database functions of migration 0102 do the work and check who is asking).
 *
 * Linking: "Connect" asks for a one-time link, shows it, and polls the person's
 * own channel list until the chat appears (the person pressed Start and
 * confirmed in Telegram) or the link's 10 minutes pass. The link is only ever in
 * memory: never stored, logged or put in the URL of this page.
 */
export function NotificationChannels({
  initialChannels,
  initialPreferences,
}: {
  initialChannels: ChannelRow[];
  initialPreferences: PreferenceRow[];
}) {
  const { t, locale } = useI18n();
  const n = t.notifyChannels;
  const toast = useToast();
  const [channels, setChannels] = useState(initialChannels);
  const [prefs, setPrefs] = useState(initialPreferences);
  const [waiting, setWaiting] = useState<{ url: string; expiresAt: number; known: string } | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const alive = useRef(true);
  const titleId = useId();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const say = useCallback(
    (code: unknown) => {
      const key: ChannelError = isChannelError(code) ? code : "failed";
      setInfo(null);
      setError(n.errors[key]);
    },
    [n],
  );

  const refresh = useCallback(async (): Promise<ChannelRow[] | null> => {
    try {
      const res = await fetch("/api/notifications/telegram", { cache: "no-store" });
      if (!res.ok) return null;
      const body = await res.json();
      const rows = parseChannels(body.channels);
      if (!alive.current) return rows;
      setChannels(rows);
      setPrefs(parsePreferences(body.preferences));
      return rows;
    } catch {
      return null;
    }
  }, []);

  // While waiting for the person in Telegram: look for the new chat, stop at expiry.
  useEffect(() => {
    if (!waiting) return;
    const id = window.setInterval(async () => {
      if (Date.now() > waiting.expiresAt) {
        setWaiting(null);
        setExpired(true);
        return;
      }
      const rows = await refresh();
      if (rows && signature(rows) !== waiting.known) {
        setWaiting(null);
        setExpired(false);
        setError(null);
        setInfo(n.connectedNow);
        toast.success(n.connectedNow);
      }
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [waiting, refresh, n.connectedNow, toast]);

  async function post(path: string, payload: Record<string, unknown>): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    try {
      const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { ok: res.ok && body.ok === true, body };
    } catch {
      return { ok: false, body: { error: "failed" } };
    }
  }

  async function connect() {
    if (busy) return;
    setBusy("connect");
    setError(null);
    setInfo(null);
    setExpired(false);
    const { ok, body } = await post("/api/notifications/telegram", { locale });
    if (!alive.current) return;
    setBusy(null);
    if (!ok || typeof body.url !== "string") return say(body.error);
    const exp = typeof body.expires_at === "string" ? Date.parse(body.expires_at) : NaN;
    setWaiting({ url: body.url, expiresAt: Number.isFinite(exp) ? exp : Date.now() + 10 * 60 * 1000, known: signature(channels) });
  }

  async function act(id: string, action: ChannelAction, extra: Record<string, unknown> = {}) {
    if (busy) return;
    setBusy(`${id}:${action}`);
    setError(null);
    setInfo(null);
    setAsking(null);
    const { ok, body } = await post("/api/notifications/telegram/channel", { id, action, ...extra });
    if (!alive.current) return;
    setBusy(null);
    if (!ok) {
      say(body.error);
      if (body.error === "not_found") void refresh();
      return;
    }
    if (action === "test") {
      setInfo(n.testQueued);
      toast.success(n.testQueued);
    }
    await refresh();
  }

  async function toggle(event: PreferenceRow["event"], enabled: boolean) {
    if (busy) return;
    const before = prefs;
    setPrefs((p) => p.map((r) => (r.event === event ? { ...r, enabled } : r)));
    setBusy(`pref:${event}`);
    setError(null);
    setInfo(null);
    const { ok, body } = await post("/api/notifications/telegram/preference", { event, enabled });
    if (!alive.current) return;
    setBusy(null);
    if (!ok) {
      setPrefs(before);
      say(body.error);
    }
  }

  const when = (iso: string | null) => {
    const d = iso ? new Date(iso) : null;
    return d && Number.isFinite(d.getTime()) ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d) : null;
  };

  return (
    <section className="panel flex flex-col gap-6 p-5 sm:p-6" aria-labelledby={titleId} data-testid="notify-channels">
      <div>
        <h2 id={titleId} className="t-section">
          {n.title}
        </h2>
        <p className="g5-sub">{n.sub}</p>
      </div>

      <div className="flex flex-col gap-4">
        <h3 className="g5-h">{n.telegram}</h3>

        {channels.map((c) => {
          const last = when(c.last_ok_at);
          return (
            <div key={c.id} className="flex flex-col gap-3 border-t border-[var(--ns-rule)] pt-4 first:border-t-0 first:pt-0" data-testid="notify-channel">
              <p className="g5-note">
                <strong className="g5-v">{c.label ? fmt(n.connectedAs, { name: c.label }) : n.connected}</strong>
                {" · "}
                <span data-testid="notify-channel-status">{n.status[c.status]}</span>
              </p>
              {c.status === "blocked" && <p className="g5-note g5-fail-text">{n.blockedHelp}</p>}
              {c.status === "paused" && <p className="g5-note">{n.pausedHelp}</p>}
              <p className="g5-note">{last ? fmt(n.lastDelivered, { when: last }) : n.neverDelivered}</p>
              <label className="flex flex-col gap-1 text-sm">
                <span className="g5-note">{n.language}</span>
                <select
                  className="input max-w-[14rem]"
                  value={LOCALES.some((l) => l.code === c.locale) ? c.locale : "en"}
                  disabled={busy !== null}
                  onChange={(e) => void act(c.id, "locale", { locale: e.target.value })}
                >
                  {LOCALES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="g5-actions">
                <button type="button" className="btn-quiet px-5 text-sm" disabled={busy !== null || c.status !== "active"} onClick={() => void act(c.id, "test")}>
                  {n.sendTest}
                </button>
                {c.status === "paused" && (
                  <button type="button" className="btn-quiet px-5 text-sm" disabled={busy !== null} onClick={() => void act(c.id, "resume")}>
                    {n.resume}
                  </button>
                )}
                {c.status === "active" && (
                  <button type="button" className="btn-quiet px-5 text-sm" disabled={busy !== null} onClick={() => void act(c.id, "pause")}>
                    {n.pause}
                  </button>
                )}
                {asking === c.id ? (
                  <>
                    <span className="g5-note">{n.disconnectAsk}</span>
                    <button type="button" className="btn-quiet px-5 text-sm" disabled={busy !== null} onClick={() => void act(c.id, "disconnect")}>
                      {n.disconnectYes}
                    </button>
                    <button type="button" className="btn-quiet px-5 text-sm" onClick={() => setAsking(null)}>
                      {n.keep}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn-quiet px-5 text-sm" disabled={busy !== null} onClick={() => setAsking(c.id)}>
                    {n.disconnect}
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {waiting && (
          <div className="flex flex-col gap-3" role="status" data-testid="notify-waiting">
            <p className="g5-note">
              <strong className="g5-v">{n.waitingTitle}</strong>
            </p>
            <p className="g5-note">{n.waitingBody}</p>
            <div className="g5-actions">
              <a href={waiting.url} target="_blank" rel="noopener noreferrer" className="btn-quiet px-5 text-sm">
                {n.openTelegram} <span className="sr-only">{n.newTab}</span>
              </a>
              <button type="button" className="btn-quiet px-5 text-sm" onClick={() => setWaiting(null)}>
                {n.cancel}
              </button>
            </div>
          </div>
        )}

        {expired && !waiting && (
          <p className="g5-note" role="status">
            {n.expired}
          </p>
        )}

        {!waiting && (
          <div className="flex flex-col gap-2">
            <div className="g5-actions">
              <button type="button" className="btn-quiet px-5 text-sm" disabled={busy !== null} onClick={() => void connect()}>
                {busy === "connect" ? n.opening : channels.length > 0 ? n.connectAnother : n.connect}
              </button>
            </div>
            <p className="g5-note">{n.consent}</p>
          </div>
        )}

        {error && (
          <p role="alert" className="g5-note g5-fail-text" data-testid="notify-error">
            {error}
          </p>
        )}
        {info && (
          <p role="status" className="g5-note">
            {info}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-[var(--ns-rule)] pt-6">
        <h3 className="g5-h">{n.eventsTitle}</h3>
        {channels.length === 0 && <p className="g5-note">{n.eventsNeedChat}</p>}
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {CHANNEL_EVENTS.map((event) => {
            const on = prefs.find((p) => p.event === event)?.enabled ?? false;
            const labelId = `${titleId}-${event}`;
            return (
              <li key={event} className="flex items-center justify-between gap-4">
                <span id={labelId} className="text-sm">
                  {n.events[event]}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-labelledby={labelId}
                  disabled={busy !== null || channels.length === 0}
                  onClick={() => void toggle(event, !on)}
                  className="btn-quiet shrink-0 px-4 py-2 text-sm disabled:opacity-50"
                  style={{ borderColor: on ? "var(--color-ok)" : "var(--color-border)", color: on ? "var(--color-ok)" : "var(--color-muted)" }}
                >
                  {on ? "✓" : "–"}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/** A comparable fingerprint of the chats: a new or re-linked chat changes it. */
function signature(rows: ChannelRow[]): string {
  return rows.map((r) => `${r.id}:${r.status}:${r.verified_at ?? ""}`).sort().join("|");
}
