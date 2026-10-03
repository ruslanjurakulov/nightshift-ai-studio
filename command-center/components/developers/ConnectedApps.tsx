"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n/core";
import { describeRedirect } from "@/lib/oauth/redirect";

/**
 * Connected apps (migration 0093): the AI apps this person allowed to use
 * their workspace, each with what it may spend this month and a button that
 * ends it at once. Read and written through the person's own session and the
 * oauth_* functions, which show them only their own connections. A connection
 * whose plan lapsed reads "paused", not nothing: it works again, without
 * reconnecting, when a plan returns. Raising a limit is only possible here —
 * the app has no way to.
 */

interface Grant {
  id: string;
  client_name: string;
  redirect_uris: string[];
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  monthly_limit_credits: number;
  spent_this_month_credits: number;
  status: "active" | "paused_plan";
}

const MAX_LIMIT = 20000;
const INPUT =
  "min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]";

function isMissing(e: { code?: string; message?: string } | null): boolean {
  return !!e && (e.code === "PGRST202" || e.code === "42883" || /could not find the function|does not exist/i.test(e.message ?? ""));
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function ConnectedApps() {
  const { t, locale } = useI18n();
  const c = t.connectedApps;
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "fail"; text: string } | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    if (!supabase) return;
    const { data, error } = await supabase.rpc("oauth_my_grants");
    if (error) {
      setState(isMissing(error) ? "missing" : "error");
      return;
    }
    const rows = (Array.isArray(data) ? data : []) as Grant[];
    setGrants(rows);
    setDrafts(Object.fromEntries(rows.map((g) => [g.id, String(g.monthly_limit_credits)])));
    setState("ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const day = (iso: string) => new Date(iso).toLocaleDateString(locale, { dateStyle: "medium" });

  async function revoke(g: Grant) {
    if (!window.confirm(fmt(c.sure, { app: g.client_name }))) return;
    const supabase = createClient();
    if (!supabase) return;
    setBusy(g.id);
    setNote(null);
    const { error } = await supabase.rpc("oauth_revoke_grant", { p_grant: g.id });
    setBusy(null);
    if (error) return setNote({ tone: "fail", text: c.actionFailed });
    await load();
  }

  async function revokeAll() {
    if (!window.confirm(c.disconnectAll + "?")) return;
    const supabase = createClient();
    if (!supabase) return;
    setBusy("all");
    setNote(null);
    const { error } = await supabase.rpc("oauth_revoke_all_grants");
    setBusy(null);
    if (error) return setNote({ tone: "fail", text: c.actionFailed });
    await load();
  }

  async function saveLimit(g: Grant) {
    const raw = (drafts[g.id] ?? "").trim();
    const n = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > MAX_LIMIT) return setNote({ tone: "fail", text: fmt(c.limitInvalid, { max: MAX_LIMIT }) });
    const supabase = createClient();
    if (!supabase) return;
    setBusy(g.id);
    setNote(null);
    const { error } = await supabase.rpc("oauth_set_grant_limit", { p_grant: g.id, p_limit: n });
    setBusy(null);
    if (error) return setNote({ tone: "fail", text: c.actionFailed });
    setNote({ tone: "ok", text: c.limitSaved });
    await load();
  }

  return (
    <section className="panel p-4" aria-labelledby="connected-apps-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="connected-apps-title" className="text-[15px] font-semibold">
          {c.title}
        </h2>
        {grants && grants.length > 1 && (
          <button type="button" className="btn-sky pill px-4 py-1.5 text-[13px] disabled:opacity-40" disabled={busy !== null} onClick={() => void revokeAll()}>
            {busy === "all" ? c.disconnecting : c.disconnectAll}
          </button>
        )}
      </div>
      <p className="mt-1 text-[13px] text-[var(--color-muted)]">{c.lead}</p>

      {state === "loading" && <p className="mt-3 text-[13px] text-[var(--color-muted)]">…</p>}
      {state === "missing" && <p className="mt-3 text-[13px] text-[var(--color-muted)]">{c.notMigrated}</p>}
      {state === "error" && <p className="mt-3 text-[13px] text-[var(--color-muted)]">{c.loadFailed}</p>}
      {note && (
        <p role="status" className={`mt-3 text-[13px] ${note.tone === "fail" ? "text-[var(--color-fail,#c0392b)]" : "text-[var(--color-muted)]"}`}>
          {note.text}
        </p>
      )}
      {state === "ready" && grants && grants.length === 0 && <p className="mt-3 text-[13px] text-[var(--color-muted)]">{c.empty}</p>}

      {state === "ready" && grants && grants.length > 0 && (
        <ul className="mt-3 flex flex-col gap-3">
          {grants.map((g) => {
            const where = g.redirect_uris[0] ? describeRedirect(g.redirect_uris[0]).host : "";
            const scopeNames = g.scopes.map((s) => (s === "videos:read" ? c.scopesRead : s === "videos:create" ? c.scopesCreate : c.scopesPublish));
            return (
              <li key={g.id} className="rounded-md border border-[var(--color-border)] p-3" data-testid="connected-app">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words text-[14px] font-semibold">{g.client_name}</p>
                    <p className="break-all text-[12px] text-[var(--color-muted)]">{where}</p>
                  </div>
                  <span className="text-[12px] text-[var(--color-muted)]">{g.status === "paused_plan" ? c.paused : c.active}</span>
                </div>
                <p className="mt-1 text-[12px] text-[var(--color-muted)]">
                  {fmt(c.created, { date: day(g.created_at) })} · {g.last_used_at ? fmt(c.lastUsed, { date: day(g.last_used_at) }) : c.neverUsed} · {scopeNames.join(", ")}
                </p>
                {g.status === "paused_plan" && (
                  <p className="mt-2 text-[13px]">
                    {c.pausedHelp}{" "}
                    <Link href="/pricing" className="underline">
                      {c.seePlans}
                    </Link>
                  </p>
                )}
                <p className="mt-2 text-[13px]">
                  {c.spent}: <strong>{fmt(c.credits, { n: trim(g.spent_this_month_credits) })}</strong>
                </p>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
                    {c.limit} ({fmt(c.credits, { n: "" }).trim()})
                    <input
                      className={`${INPUT} w-32`}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={drafts[g.id] ?? ""}
                      onChange={(e) => setDrafts((d) => ({ ...d, [g.id]: e.target.value }))}
                    />
                  </label>
                  <button type="button" className="btn-sky pill px-4 py-1.5 text-[13px] disabled:opacity-40" disabled={busy !== null} onClick={() => void saveLimit(g)}>
                    {c.saveLimit}
                  </button>
                  <button type="button" className="btn-sky pill px-4 py-1.5 text-[13px] disabled:opacity-40" disabled={busy !== null} onClick={() => void revoke(g)}>
                    {busy === g.id ? c.disconnecting : c.disconnect}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
