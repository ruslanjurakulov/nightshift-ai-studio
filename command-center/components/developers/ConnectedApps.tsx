"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n/core";
import { AppName } from "@/components/oauth/AppName";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
import { cleanClientName, describeRedirect } from "@/lib/oauth/redirect";
import { MCP_CLIENTS, installLink } from "@/lib/dev/mcp-clients";
import { InstallButton } from "@/components/docs/InstallButton";

/**
 * Connected apps (migration 0093): the AI apps this person allowed to use
 * their workspace, each with what it may spend this month and a button that
 * ends it at once. Read and written through the person's own session and the
 * oauth_* functions, which show them only their own connections. Since 0147
 * every plan may connect and the database answers "active" for every live
 * connection; a database that still gates by plan (before 0147, or after its
 * rollback) answers "paused_plan", which reads "paused", not nothing: it works
 * again, without reconnecting, once the plan includes it. Raising a limit is only possible here —
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
  "min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-base text-[var(--color-fg)] sm:min-h-11 outline-none focus:border-[var(--color-primary)]";

function isMissing(e: { code?: string; message?: string } | null): boolean {
  return !!e && (e.code === "PGRST202" || e.code === "42883" || /could not find the function|does not exist/i.test(e.message ?? ""));
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * "Add an assistant": the four assistants and one-click buttons /mcp has, for a person already in the console. Drawn only when the
 * server's sign-in is live (MCP_OAUTH_LIVE, read on the server and passed in): every button starts a sign-in, and
 * while the server takes API keys only, a button here would lead into a flow that cannot finish. Each button
 * keeps a "Steps by hand" link beside it, because a cursor: link does nothing where Cursor is missing, and ChatGPT, Gemini and Grok have no install link at all.
 */
function AddAssistant({ mcpUrl }: { mcpUrl: string }) {
  const { t } = useI18n();
  const c = t.connectedApps;
  return (
    <div className="mt-3 rounded-[var(--ns-r-panel)] bg-[var(--ns-key)] p-4" data-testid="add-assistant">
      <h3 className="text-base font-semibold">{c.addTitle}</h3>
      <p className="mt-1 text-sm text-[var(--color-muted)]">{c.addLead}</p>
      <ul className="mt-3 flex flex-col gap-2">
        {MCP_CLIENTS.map((client) => {
          // ChatGPT, Gemini and Grok document no install link: their row is the name and the steps by hand.
          const link = installLink(client.id, mcpUrl);
          return (
            <li key={client.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {link ? (
                <InstallButton
                  link={link}
                  label={fmt(c.addTo, { app: client.shortLabel ?? client.label })}
                  newTab={c.newTab}
                  className="btn-quiet inline-flex items-center gap-2 [&_svg]:size-4"
                />
              ) : (
                <span className="text-sm font-semibold">{client.label}</span>
              )}
              <Link href={`/mcp?tab=${client.id}`} className="text-sm underline" prefetch={false}>
                {c.addSteps}
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        {c.addUrl}:{" "}
        <code className="break-all font-mono text-[var(--color-fg)] select-all" dir="ltr">
          {mcpUrl}
        </code>
      </p>
    </div>
  );
}

export function ConnectedApps({ mcpUrl, oauthLive = false }: { mcpUrl?: string; oauthLive?: boolean } = {}) {
  const { t, locale } = useI18n();
  const c = t.connectedApps;
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
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

  // Uzbek has no usable short-month names in the browser ("2026 M09 1"): numbers only there.
  const day = (iso: string) =>
    locale === "uz"
      ? new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso))
      : new Date(iso).toLocaleDateString(locale, { dateStyle: "medium" });

  async function revoke(g: Grant) {
    const supabase = createClient();
    if (!supabase || busy) return;
    const app = cleanClientName(g.client_name, "?");
    setBusy(g.id);
    setNote(null);
    const done = await confirm({
      title: `${c.disconnect}: ${app}`,
      message: fmt(c.sure, { app }),
      confirmLabel: c.disconnect,
      run: async () => {
        const { error } = await supabase.rpc("oauth_revoke_grant", { p_grant: g.id });
        return error ? c.actionFailed : true;
      },
    });
    setBusy(null);
    if (done) await load();
  }

  async function revokeAll() {
    const supabase = createClient();
    if (!supabase || busy) return;
    setBusy("all");
    setNote(null);
    const done = await confirm({
      title: c.disconnectAll,
      message: c.disconnectAll + "?",
      confirmLabel: c.disconnectAll,
      run: async () => {
        const { error } = await supabase.rpc("oauth_revoke_all_grants");
        return error ? c.actionFailed : true;
      },
    });
    setBusy(null);
    if (done) await load();
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
    <section className="fl-card" aria-labelledby="connected-apps-title">
      {dialog}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="connected-apps-title" className="fl-q">
          {c.title}
        </h2>
        {grants && grants.length > 1 && (
          <button type="button" className="btn-quiet disabled:opacity-40" disabled={busy !== null} onClick={() => void revokeAll()}>
            {busy === "all" ? c.disconnecting : c.disconnectAll}
          </button>
        )}
      </div>
      <p className="fl-hint">{c.lead}</p>
      {oauthLive && mcpUrl && <AddAssistant mcpUrl={mcpUrl} />}

      {state === "loading" && <p className="mt-3 text-sm text-[var(--color-muted)]">…</p>}
      {state === "missing" && <p className="mt-3 text-sm text-[var(--color-muted)]">{c.notMigrated}</p>}
      {state === "error" && <p className="mt-3 text-sm text-[var(--color-muted)]">{c.loadFailed}</p>}
      {note && (
        <p role="status" className={`mt-3 text-sm ${note.tone === "fail" ? "text-[var(--color-fail,#c0392b)]" : "text-[var(--color-muted)]"}`}>
          {note.text}
        </p>
      )}
      {state === "ready" && grants && grants.length === 0 && <p className="mt-3 text-sm text-[var(--color-muted)]">{c.empty}</p>}

      {state === "ready" && grants && grants.length > 0 && (
        <ul className="flex flex-col gap-3">
          {grants.map((g) => {
            const where = g.redirect_uris[0] ? describeRedirect(g.redirect_uris[0]).host : "";
            const scopeNames = g.scopes.map((s) => (s === "videos:read" ? c.scopesRead : s === "videos:create" ? c.scopesCreate : c.scopesPublish));
            return (
              <li key={g.id} className="rounded-[var(--ns-r-panel)] bg-[var(--ns-key)] p-4" data-testid="connected-app">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-words text-base"><AppName name={g.client_name} /></p>
                    <p className="break-all font-mono text-sm text-[var(--color-muted)]" dir="ltr">{where}</p>
                  </div>
                  <span className={`rounded-full bg-[var(--color-panel)] px-3 py-1 text-sm ${g.status === "paused_plan" ? "font-semibold text-[var(--color-fg)]" : "text-[var(--color-muted)]"}`}>
                    {g.status === "paused_plan" ? c.paused : c.active}
                  </span>
                </div>
                <p className="mt-1 text-sm text-[var(--color-muted)]">
                  {fmt(c.created, { date: day(g.created_at) })} · {g.last_used_at ? fmt(c.lastUsed, { date: day(g.last_used_at) }) : c.neverUsed} · {scopeNames.join(", ")}
                </p>
                {g.status === "paused_plan" && (
                  <p className="mt-2 text-sm">
                    {c.pausedHelp}{" "}
                    <Link href="/pricing" className="underline">
                      {c.seePlans}
                    </Link>
                  </p>
                )}
                <p className="mt-2 text-sm">
                  {c.spent}: <strong>{fmt(c.credits, { n: `${trim(g.spent_this_month_credits)} / ${trim(g.monthly_limit_credits)}` })}</strong>
                </p>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-sm text-[var(--color-muted)]">
                    {c.limit} ({fmt(c.credits, { n: "" }).trim()})
                    <input
                      className={`${INPUT} w-32`}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={drafts[g.id] ?? ""}
                      onChange={(e) => setDrafts((d) => ({ ...d, [g.id]: e.target.value }))}
                    />
                  </label>
                  <button type="button" className="btn-quiet disabled:opacity-40" disabled={busy !== null} onClick={() => void saveLimit(g)}>
                    {c.saveLimit}
                  </button>
                  <button type="button" className="btn-quiet disabled:opacity-40" disabled={busy !== null} onClick={() => void revoke(g)}>
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
