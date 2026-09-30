"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { StatusPill } from "@/components/ui";
import { ErrorState } from "@/components/ReadError";
import { resolvedTheme } from "@/lib/theme";
import { paddleLocale, type PaddleEnvironment } from "@/lib/paddle";
import { ensurePaddle, type PaddleEventData } from "@/lib/paddle-client";
import { API_KEY_LIST_COLUMNS, createKeyArgs, MAX_ACTIVE_KEYS, mintedKey } from "@/lib/api/keys";
import {
  API_TERMS_VERSION,
  API_TIERS,
  formatUsd,
  parseLimitDollars,
  parseTopupDollars,
} from "@/lib/api/pricing";

/**
 * The Developer console (migration 0031), for an owner/admin of the
 * organization being viewed.
 *
 * Every read and write goes through the browser's own session (anon key +
 * RLS) and 0031's functions, which check the role again. A new key is
 * minted by the database (create_api_key, 0042), which keeps only its SHA-256
 * and returns the key once; it is shown once, in the dialog below, and
 * forgotten when the dialog closes — a browser cannot pick its own key. In
 * the list a key is its name, id, creation and last-use time — nothing of the
 * key itself (CLAUDE.md #1). Top-ups open Paddle's overlay on
 * a transaction the server created; the webhook credits the balance.
 */

type Tab = "overview" | "keys" | "usage" | "billing" | "limits";

interface Console {
  eligible: boolean;
  activated_at: string | null;
  exempt: boolean;
  balance_cents: number;
  reserved_cents: number;
  paid_total_cents: number;
  tier: number;
  rpm: number;
  concurrency: number;
  tier_cap_cents: number | null;
  monthly_limit_cents: number | null;
  month_spend_cents: number;
  active_keys: number;
}

interface KeyRow {
  id: string;
  name: string;
  monthly_limit_cents: number | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface UsageDay {
  day: string;
  requests: number;
  errors: number;
  spend_cents: number;
}

interface Usage {
  days: UsageDay[];
  endpoints: { endpoint: string; requests: number; errors: number }[];
}

interface LedgerRow {
  id: number;
  kind: "topup" | "refund" | "adjustment";
  amount_cents: number;
  external_id: string | null;
  created_at: string;
}

function isMissing(e: { code?: string; message?: string } | null): boolean {
  return !!e && (e.code === "PGRST202" || e.code === "42P01" || e.code === "PGRST205" || /does not exist|could not find/i.test(e.message ?? ""));
}

export function DeveloperConsole({
  orgId,
  topup,
}: {
  orgId: string;
  topup: { environment: PaddleEnvironment; clientToken: string } | null;
}) {
  const { t, locale } = useI18n();
  const d = t.developers;
  const path = useChannelPath();
  const [tab, setTab] = useState<Tab>("overview");
  const [info, setInfo] = useState<Console | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");

  const load = useCallback(async () => {
    const supabase = createClient();
    if (!supabase) return;
    const { data, error } = await supabase.rpc("api_console", { p_org: orgId });
    if (error) {
      setState(isMissing(error) ? "missing" : "error");
      return;
    }
    setInfo(data as Console);
    setState("ready");
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  if (state === "loading") return <div className="panel p-4 text-[13px] text-[var(--color-muted)]">…</div>;
  if (state === "missing") return <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{d.notMigrated}</div>;
  if (state === "error" || !info) return <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{d.loadFailed}</div>;

  const tabs: [Tab, string][] = [
    ["overview", d.tabOverview],
    ["keys", d.tabKeys],
    ["usage", d.tabUsage],
    ["billing", d.tabBilling],
    ["limits", d.tabLimits],
  ];

  return (
    <div className="rhythm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" className="flex flex-wrap gap-1.5">
          {tabs.map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              type="button"
              onClick={() => setTab(k)}
              className={`pill px-3.5 py-1.5 text-[13px] ${tab === k ? "btn-sky is-solid" : "btn-sky"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <a href="/docs/api" target="_blank" rel="noreferrer" className="text-[13px] underline">
          {d.docsLink}
        </a>
      </div>

      {!info.activated_at ? (
        <Activate orgId={orgId} info={info} onDone={load} creditsHref={path("credits")} />
      ) : null}

      {tab === "overview" && <Overview info={info} locale={locale} />}
      {tab === "keys" && <Keys orgId={orgId} activated={!!info.activated_at} />}
      {tab === "usage" && <UsageTab orgId={orgId} locale={locale} />}
      {tab === "billing" && <Billing orgId={orgId} info={info} topup={topup} onPaid={load} />}
      {tab === "limits" && <Limits orgId={orgId} info={info} onSaved={load} />}
    </div>
  );
}

function Activate({
  orgId,
  info,
  onDone,
  creditsHref,
}: {
  orgId: string;
  info: Console;
  onDone: () => void;
  creditsHref: string;
}) {
  const { t } = useI18n();
  const d = t.developers;
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function activate() {
    const supabase = createClient();
    if (!supabase || !accepted || busy) return;
    setBusy(true);
    setError(null);
    const { error: e } = await supabase.rpc("api_activate", { p_org: orgId, p_terms_version: API_TERMS_VERSION });
    setBusy(false);
    if (e) {
      setError(d.activateFailed);
      return;
    }
    onDone();
  }

  return (
    <div className="panel flex flex-col gap-3 p-4">
      <h2 className="t-section">{d.activateTitle}</h2>
      <p className="text-[13px] text-[var(--color-muted)]">{d.activateBody}</p>
      {!info.eligible ? (
        <p className="text-[13px]">
          {d.notEligible}{" "}
          <Link className="underline" href={creditsHref}>
            {d.buyCredits}
          </Link>
        </p>
      ) : (
        <>
          <label className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5" />
            <span>
              {d.acceptTerms}{" "}
              <a className="underline" href="/terms" target="_blank" rel="noreferrer">
                {d.termsLink}
              </a>
            </span>
          </label>
          <div>
            <button
              type="button"
              onClick={activate}
              disabled={!accepted || busy}
              className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
            >
              {busy ? d.activating : d.activate}
            </button>
          </div>
        </>
      )}
      {error && <p className="text-[13px] text-[var(--color-fail)]">{error}</p>}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="panel flex flex-col gap-1 p-4">
      <span className="text-[12px] text-[var(--color-muted)]">{label}</span>
      <span className="text-[20px] font-semibold tabular-nums">{value}</span>
      {sub ? <span className="text-[12px] text-[var(--color-muted)]">{sub}</span> : null}
    </div>
  );
}

function Overview({ info, locale }: { info: Console; locale: string }) {
  const { t, fmt } = useI18n();
  const d = t.developers;
  const next = API_TIERS.find((x) => x.tier === info.tier + 1);
  const limit =
    info.tier_cap_cents === null
      ? null
      : Math.min(info.tier_cap_cents, info.monthly_limit_cents ?? info.tier_cap_cents);
  return (
    <div className="rhythm">
      {info.activated_at && (
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--color-muted)]">
          <StatusPill tone="ok" label={fmt(d.activeSince, { date: new Date(info.activated_at).toLocaleDateString(locale) })} />
          {info.exempt && <span>{d.exemptNote}</span>}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={d.available}
          value={info.exempt ? "—" : formatUsd(info.balance_cents - info.reserved_cents, locale)}
          sub={info.exempt ? undefined : `${d.onHold}: ${formatUsd(info.reserved_cents, locale)}`}
        />
        <Stat
          label={d.tier}
          value={fmt(d.tierN, { n: info.tier })}
          sub={next && !info.exempt ? fmt(d.nextTier, { n: next.tier, amount: formatUsd(next.minPaidCents, locale) }) : d.topTier}
        />
        <Stat
          label={d.monthSpend}
          value={formatUsd(info.month_spend_cents, locale)}
          sub={`${d.monthlyLimit}: ${limit === null ? d.noLimit : formatUsd(limit, locale)}`}
        />
        <Stat label={d.rpm} value={String(info.rpm)} sub={`${d.concurrency}: ${info.concurrency}`} />
      </div>
    </div>
  );
}

export function Keys({ orgId, activated }: { orgId: string; activated: boolean }) {
  const { t, locale } = useI18n();
  const d = t.developers;
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [keysFailed, setKeysFailed] = useState(false);
  const [name, setName] = useState("");
  const [limitText, setLimitText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    if (!supabase) return;
    const { data, error: readErr } = await supabase.from("api_keys").select(API_KEY_LIST_COLUMNS).eq("org_id", orgId).order("created_at", { ascending: false });
    // A failed read is not "no keys".
    setKeysFailed(Boolean(readErr));
    setKeys(readErr ? null : ((data as KeyRow[] | null) ?? []));
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const active = (keys ?? []).filter((k) => !k.revoked_at).length;

  async function create() {
    const supabase = createClient();
    const clean = name.trim();
    const limit = parseLimitDollars(limitText);
    if (!supabase || busy || !clean) return;
    if (!limit.ok) {
      setError(d.limitInvalid);
      return;
    }
    setBusy(true);
    setError(null);
    const { data, error: e } = await supabase.rpc("create_api_key", createKeyArgs(orgId, clean, limit.cents));
    setBusy(false);
    const key = e ? null : mintedKey(data);
    if (!key) {
      setError(e?.code === "NS409" ? d.keyLimitReached : isMissing(e) ? d.createNeedsMigration : d.createFailed);
      await load();
      return;
    }
    setShown(key);
    setCopied(false);
    setName("");
    setLimitText("");
    await load();
  }

  async function revoke(k: KeyRow) {
    const supabase = createClient();
    if (!supabase || !window.confirm(d.revokeConfirm)) return;
    const { error: e } = await supabase.rpc("revoke_api_key", { p_key_id: k.id });
    if (e) setError(d.revokeFailed);
    await load();
  }

  async function setKeyLimit(k: KeyRow) {
    const supabase = createClient();
    const raw = window.prompt(d.keyLimit, k.monthly_limit_cents === null ? "" : String(k.monthly_limit_cents / 100));
    if (!supabase || raw === null) return;
    const limit = parseLimitDollars(raw);
    if (!limit.ok) {
      setError(d.limitInvalid);
      return;
    }
    const { error: e } = await supabase.rpc("set_api_key_limit", { p_key_id: k.id, p_cents: limit.cents });
    setError(e ? d.saveFailed : null);
    await load();
  }

  const input =
    "min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]";

  if (!activated) return <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{d.activateFirst}</div>;

  return (
    <div className="rhythm">
      {shown && (
        <div className="panel flex flex-col gap-3 border-[var(--color-primary)] p-4">
          <h2 className="t-section">{d.newKeyTitle}</h2>
          <p className="text-[13px] text-[var(--color-muted)]">{d.newKeyNote}</p>
          <code className="mono break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-[13px]">{shown}</code>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-sky pill px-4 py-1.5 text-[13px]"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(shown);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? d.copied : d.copy}
            </button>
            <button type="button" className="btn-sky is-solid pill px-4 py-1.5 text-[13px]" onClick={() => setShown(null)}>
              {d.done}
            </button>
          </div>
        </div>
      )}

      <div className="panel flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-1 flex-col gap-1 text-[12px] text-[var(--color-muted)]">
            {d.keyName}
            <input className={input} value={name} maxLength={60} placeholder={d.keyNamePh} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="flex w-56 flex-col gap-1 text-[12px] text-[var(--color-muted)]">
            {d.keyLimit}
            <input className={input} value={limitText} inputMode="decimal" onChange={(e) => setLimitText(e.target.value)} />
          </label>
          <button
            type="button"
            onClick={create}
            disabled={busy || !name.trim() || active >= MAX_ACTIVE_KEYS}
            className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40"
          >
            {busy ? d.creating : d.create}
          </button>
        </div>
        {active >= MAX_ACTIVE_KEYS && <p className="text-[12px] text-[var(--color-muted)]">{d.keyLimitReached}</p>}
        {error && <p className="text-[13px] text-[var(--color-fail)]">{error}</p>}
      </div>

      <div className="panel overflow-x-auto p-4">
        {keysFailed ? (
          <ErrorState compact onRetry={load} />
        ) : keys === null ? (
          <p className="text-[13px] text-[var(--color-muted)]">…</p>
        ) : keys.length === 0 ? (
          <p className="text-[13px] text-[var(--color-muted)]">{d.noKeys}</p>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="text-[12px] text-[var(--color-muted)]">
              <tr>
                <th className="py-1 pr-3">{d.keyName}</th>
                <th className="py-1 pr-3">{d.keyId}</th>
                <th className="py-1 pr-3">{d.created}</th>
                <th className="py-1 pr-3">{d.lastUsed}</th>
                <th className="py-1 pr-3">{d.keyLimitShort}</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {keys.map((k) => (
                <tr key={k.id} className={k.revoked_at ? "opacity-50" : ""}>
                  <td className="py-2 pr-3">{k.name}</td>
                  <td className="mono py-2 pr-3 text-[12px]">{k.id}</td>
                  <td className="py-2 pr-3">{new Date(k.created_at).toLocaleDateString(locale)}</td>
                  <td className="py-2 pr-3">{k.last_used_at ? new Date(k.last_used_at).toLocaleString(locale) : d.never}</td>
                  <td className="py-2 pr-3">{k.monthly_limit_cents === null ? d.noLimit : formatUsd(k.monthly_limit_cents, locale)}</td>
                  <td className="py-2 text-right">
                    {k.revoked_at ? (
                      <span className="text-[12px]">{d.revoked}</span>
                    ) : (
                      <span className="flex justify-end gap-2">
                        <button type="button" className="text-[12px] underline" onClick={() => setKeyLimit(k)}>
                          {d.setLimit}
                        </button>
                        <button type="button" className="text-[12px] underline" onClick={() => revoke(k)}>
                          {d.revoke}
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Daily bars in the dashboard's tokens: one bar per day, the tallest = 100%. */
function Bars({ label, values, format }: { label: string; values: { day: string; v: number }[]; format: (n: number) => string }) {
  const max = Math.max(1, ...values.map((x) => x.v));
  const w = 100 / Math.max(1, values.length);
  return (
    <div className="panel flex flex-col gap-2 p-4">
      <span className="text-[12px] text-[var(--color-muted)]">{label}</span>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-32 w-full" role="img" aria-label={label}>
        {values.map((x, i) => {
          const h = (x.v / max) * 38;
          return (
            <rect key={x.day} x={i * w + w * 0.15} y={40 - h} width={w * 0.7} height={h} fill="var(--color-primary)" opacity={0.8}>
              <title>{`${x.day}: ${format(x.v)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="flex justify-between text-[11px] text-[var(--color-muted)]">
        <span>{values[0]?.day}</span>
        <span>{values[values.length - 1]?.day}</span>
      </div>
    </div>
  );
}

function UsageTab({ orgId, locale }: { orgId: string; locale: string }) {
  const { t } = useI18n();
  const d = t.developers;
  const [usage, setUsage] = useState<Usage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    if (!supabase) return;
    supabase.rpc("api_usage", { p_org: orgId, p_days: 30 }).then(({ data, error }) => {
      if (error) setFailed(true);
      else setUsage(data as Usage);
    });
  }, [orgId]);

  if (failed) return <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{d.loadFailed}</div>;
  if (!usage) return <div className="panel p-4 text-[13px] text-[var(--color-muted)]">…</div>;
  const total = usage.days.reduce((s, x) => s + x.requests, 0);
  return (
    <div className="rhythm">
      <h2 className="t-section">{d.usageTitle}</h2>
      {total === 0 ? (
        <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{d.noUsage}</div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Bars label={d.requestsPerDay} values={usage.days.map((x) => ({ day: x.day, v: x.requests }))} format={String} />
            <Bars
              label={d.spendPerDay}
              values={usage.days.map((x) => ({ day: x.day, v: x.spend_cents }))}
              format={(n) => formatUsd(n, locale)}
            />
          </div>
          <div className="panel overflow-x-auto p-4">
            <table className="w-full text-left text-[13px]">
              <thead className="text-[12px] text-[var(--color-muted)]">
                <tr>
                  <th className="py-1 pr-3">{d.endpoint}</th>
                  <th className="py-1 pr-3">{d.requests}</th>
                  <th className="py-1">{d.errors}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {usage.endpoints.map((e) => (
                  <tr key={e.endpoint}>
                    <td className="mono py-2 pr-3">{e.endpoint}</td>
                    <td className="py-2 pr-3 tabular-nums">{e.requests}</td>
                    <td className="py-2 tabular-nums">{e.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function Billing({
  orgId,
  info,
  topup,
  onPaid,
}: {
  orgId: string;
  info: Console;
  topup: { environment: PaddleEnvironment; clientToken: string } | null;
  onPaid: () => void;
}) {
  const { t, locale } = useI18n();
  const d = t.developers;
  const [amount, setAmount] = useState("25");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [rowsFailed, setRowsFailed] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadHistory = useCallback(async () => {
    const supabase = createClient();
    if (!supabase) return;
    const { data, error: readErr } = await supabase
      .from("api_ledger")
      .select("id,kind,amount_cents,external_id,created_at")
      .eq("org_id", orgId)
      .in("kind", ["topup", "refund", "adjustment"])
      .order("id", { ascending: false })
      .limit(50);
    setRowsFailed(Boolean(readErr));
    setRows(readErr ? null : ((data as LedgerRow[] | null) ?? []));
  }, [orgId]);

  useEffect(() => {
    loadHistory();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, [loadHistory]);

  const onEvent = useMemo(
    () => (e: PaddleEventData) => {
      if (e.name !== "checkout.completed") return;
      setNote(d.topupWaiting);
      let n = 0;
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(() => {
        n += 1;
        onPaid();
        loadHistory();
        if (n >= 10 && poll.current) clearInterval(poll.current);
      }, 3000);
    },
    [d.topupWaiting, onPaid, loadHistory],
  );

  async function pay() {
    const cents = parseTopupDollars(amount);
    if (cents === null) {
      setNote(d.topupInvalid);
      return;
    }
    if (!topup || busy) return;
    setBusy(true);
    setNote(d.topupOpening);
    try {
      const res = await fetch("/api/developers/topup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org_id: orgId, amount_cents: cents }),
      });
      const body = (await res.json().catch(() => ({}))) as { transaction_id?: string };
      if (!res.ok || !body.transaction_id) throw new Error("topup");
      const paddle = await ensurePaddle(topup, onEvent);
      paddle.Checkout.open({
        transactionId: body.transaction_id,
        settings: { displayMode: "overlay", theme: resolvedTheme(), locale: paddleLocale(locale), allowLogout: false, variant: "one-page" },
      });
      setNote(null);
    } catch {
      setNote(d.topupFailed);
    } finally {
      setBusy(false);
    }
  }

  const kindLabel = { topup: d.kindTopup, refund: d.kindRefund, adjustment: d.kindAdjustment };
  const input =
    "w-36 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]";

  return (
    <div className="rhythm">
      <div className="panel flex flex-col gap-3 p-4">
        <h2 className="t-section">{d.topupTitle}</h2>
        {info.exempt ? (
          <p className="text-[13px] text-[var(--color-muted)]">{d.topupExempt}</p>
        ) : !info.activated_at ? (
          <p className="text-[13px] text-[var(--color-muted)]">{d.activateFirst}</p>
        ) : !topup ? (
          <p className="text-[13px] text-[var(--color-muted)]">{d.topupUnavailable}</p>
        ) : (
          <>
            <p className="text-[13px] text-[var(--color-muted)]">{d.topupBody}</p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
                {d.amount}
                <input className={input} value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
              </label>
              <button type="button" onClick={pay} disabled={busy} className="btn-sky is-solid pill px-5 py-2 text-[13px] disabled:opacity-40">
                {d.topup}
              </button>
            </div>
          </>
        )}
        {note && <p className="text-[13px]">{note}</p>}
      </div>

      <div className="panel overflow-x-auto p-4">
        <h2 className="t-section mb-2">{d.historyTitle}</h2>
        {rowsFailed ? (
          <ErrorState compact onRetry={loadHistory} />
        ) : rows === null ? (
          <p className="text-[13px] text-[var(--color-muted)]">…</p>
        ) : rows.length === 0 ? (
          <p className="text-[13px] text-[var(--color-muted)]">{d.noPayments}</p>
        ) : (
          <table className="w-full text-left text-[13px]">
            <tbody className="divide-y divide-[var(--color-border)]">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="py-2 pr-3">{new Date(r.created_at).toLocaleString(locale)}</td>
                  <td className="py-2 pr-3">{kindLabel[r.kind]}</td>
                  <td className="py-2 pr-3 tabular-nums">{formatUsd(r.amount_cents, locale)}</td>
                  <td className="py-2 text-right">
                    {r.kind === "topup" && r.external_id?.startsWith("txn_") ? (
                      <a
                        className="text-[12px] underline"
                        href={`/api/developers/receipt?org=${encodeURIComponent(orgId)}&txn=${encodeURIComponent(r.external_id)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {d.receipt}
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Limits({ orgId, info, onSaved }: { orgId: string; info: Console; onSaved: () => void }) {
  const { t, fmt, locale } = useI18n();
  const d = t.developers;
  const [text, setText] = useState(info.monthly_limit_cents === null ? "" : String(info.monthly_limit_cents / 100));
  const [msg, setMsg] = useState<string | null>(null);

  async function save() {
    const supabase = createClient();
    const limit = parseLimitDollars(text);
    if (!supabase) return;
    if (!limit.ok) {
      setMsg(d.limitInvalid);
      return;
    }
    const { error } = await supabase.rpc("api_set_monthly_limit", { p_org: orgId, p_cents: limit.cents });
    setMsg(error ? d.saveFailed : d.saved);
    if (!error) onSaved();
  }

  if (!info.activated_at) return <div className="panel p-4 text-[13px] text-[var(--color-muted)]">{d.activateFirst}</div>;
  return (
    <div className="panel flex flex-col gap-3 p-4">
      <h2 className="t-section">{d.limitsTitle}</h2>
      <p className="text-[13px] text-[var(--color-muted)]">
        {info.tier_cap_cents === null ? d.noLimit : fmt(d.limitsBody, { cap: formatUsd(info.tier_cap_cents, locale) })}
      </p>
      {info.tier_cap_cents !== null && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[12px] text-[var(--color-muted)]">
            {d.orgLimit}
            <input
              className="w-40 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
              value={text}
              inputMode="decimal"
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <button type="button" onClick={save} className="btn-sky is-solid pill px-5 py-2 text-[13px]">
            {d.save}
          </button>
        </div>
      )}
      {msg && <p className="text-[13px]">{msg}</p>}
    </div>
  );
}
