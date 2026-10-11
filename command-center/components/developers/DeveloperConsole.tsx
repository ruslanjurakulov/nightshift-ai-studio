"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { StatusPill } from "@/components/ui";
import { ErrorState } from "@/components/ReadError";
import { resolvedTheme } from "@/lib/theme";
import { paddleLocale, type PaddleEnvironment } from "@/lib/paddle";
import { ensurePaddle, type PaddleEventData } from "@/lib/paddle-client";
import { API_KEY_BASE_COLUMNS, API_KEY_LIST_COLUMNS, MAX_ACTIVE_KEYS, mintedKey } from "@/lib/api/keys";
import {
  API_SCOPES,
  createScopedKeyArgs,
  effectiveScopes,
  KEY_PRESETS,
  keyPresetOf,
  parseCreditLimit,
  parseRpmLimit,
  type ApiScope,
} from "@/lib/api/scopes";
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

type Tab = "keys" | "usage" | "apps";

const TABS: Tab[] = ["keys", "usage", "apps"];

/** Every name the old five tabs (and the sections that used to be on the page) were known by, and where it lands now. */
const TAB_NAMES: Record<string, Tab> = {
  keys: "keys",
  "api-keys": "keys",
  apikeys: "keys",
  usage: "usage",
  overview: "usage",
  billing: "usage",
  limits: "usage",
  topup: "usage",
  payments: "usage",
  history: "usage",
  apps: "apps",
  connected: "apps",
  "connected-apps": "apps",
  "connected-apps-title": "apps",
};

/** The tab an address asks for — `#billing`, `?tab=limits`, … — or null when it names none (the page then opens on Keys). */
export function tabFromAddress(search: string, hash: string): Tab | null {
  // The #fragment is what a tab pick writes, so it wins over an older ?tab=.
  const asked = [hash.replace(/^#/, ""), new URLSearchParams(search).get("tab")];
  for (const raw of asked) {
    const name = (raw ?? "").trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(TAB_NAMES, name)) return TAB_NAMES[name];
  }
  return null;
}

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
  /** null = made before generations existed (migration 0062). */
  scopes: string[] | null;
  rpm_limit: number | null;
  creative_monthly_credits: number | null;
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

type TopupConfig = { environment: PaddleEnvironment; clientToken: string } | null;

/**
 * The one top-up flow (unchanged): a transaction made by the server, paid in Paddle's
 * overlay, credited by the webhook. It lives here, not in a tab, so the "Add funds"
 * button beside the balance and nothing else starts it; while the balance catches up
 * it asks the console to reload (onPaid) and the payment list to read again (onTick).
 */
function useTopUp(orgId: string, topup: TopupConfig, onPaid: () => void, onTick: () => void) {
  const { t, locale } = useI18n();
  const d = t.developers;
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("25");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (poll.current) clearInterval(poll.current);
    },
    [],
  );

  const onEvent = useMemo(
    () => (e: PaddleEventData) => {
      if (e.name !== "checkout.completed") return;
      setNote(d.topupWaiting);
      let n = 0;
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(() => {
        n += 1;
        onPaid();
        onTick();
        if (n >= 10 && poll.current) clearInterval(poll.current);
      }, 3000);
    },
    [d.topupWaiting, onPaid, onTick],
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
      setOpen(false);
    } catch {
      setNote(d.topupFailed);
    } finally {
      setBusy(false);
    }
  }

  return { open, setOpen, amount, setAmount, busy, note, pay };
}

/** What can be spent now: the balance less what is on hold; null when either is not a number (unknown is not $0). */
function availableCents(info: Console | null): number | null {
  if (!info || info.exempt) return null;
  const { balance_cents: balance, reserved_cents: reserved } = info;
  return typeof balance === "number" && Number.isFinite(balance) && typeof reserved === "number" && Number.isFinite(reserved)
    ? balance - reserved
    : null;
}

/**
 * The strip above every tab: the one shared prepaid API balance of the organization,
 * with "Add funds" beside it. A balance that is not known (still loading, failed, not
 * a number, or the operator's organization) shows "—", never $0.
 */
function BalanceStrip({
  info,
  loading,
  locale,
  topup,
  top,
}: {
  info: Console | null;
  loading: boolean;
  locale: string;
  topup: TopupConfig;
  top: ReturnType<typeof useTopUp>;
}) {
  const { t } = useI18n();
  const d = t.developers;
  const available = availableCents(info);
  const canAdd = !!info && !!info.activated_at && !info.exempt;
  const input =
    "min-h-11 w-36 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-base text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]";
  return (
    <div className="flex flex-col gap-3">
      <section aria-label={d.apiBalance} className="panel flex min-h-[4.25rem] flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="text-sm text-[var(--color-muted)]">{d.apiBalance}</span>
          <span className="text-[20px] font-semibold tabular-nums" data-testid="api-balance">
            {available === null ? "—" : formatUsd(available, locale)}
          </span>
          {info && !info.exempt && available !== null ? (
            <span className="text-sm text-[var(--color-muted)]">{`${d.onHold}: ${formatUsd(info.reserved_cents, locale)}`}</span>
          ) : info?.exempt ? (
            <span className="text-sm text-[var(--color-muted)]">{d.topupExempt}</span>
          ) : !loading ? (
            <span className="text-sm text-[var(--color-muted)]">{d.balanceUnknown}</span>
          ) : null}
        </div>
        {canAdd ? (
          <button
            type="button"
            className="btn-sky is-solid pill px-5 text-sm disabled:opacity-40"
            aria-expanded={top.open}
            aria-controls="add-funds-panel"
            disabled={!topup}
            onClick={() => top.setOpen(!top.open)}
          >
            {d.addFunds}
          </button>
        ) : null}
      </section>
      {canAdd && !topup ? <p className="px-1 text-sm text-[var(--color-muted)]">{d.topupUnavailable}</p> : null}
      {canAdd && topup && top.open ? (
        <div id="add-funds-panel" className="panel flex flex-col gap-3 p-4 sm:p-5">
          <p className="text-sm text-[var(--color-muted)]">{d.topupBody}</p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm text-[var(--color-muted)]">
              {d.amount}
              <input className={input} value={top.amount} inputMode="decimal" onChange={(e) => top.setAmount(e.target.value)} />
            </label>
            <button type="button" onClick={top.pay} disabled={top.busy} className="btn-sky is-solid pill px-5 text-sm disabled:opacity-40">
              {d.topup}
            </button>
          </div>
        </div>
      ) : null}
      {top.note ? (
        <p role="status" className="px-1 text-sm">
          {top.note}
        </p>
      ) : null}
    </div>
  );
}

export function DeveloperConsole({
  orgId,
  topup,
  connectedApps,
}: {
  orgId: string;
  topup: TopupConfig;
  /** The connected-apps list: the third tab. Server-rendered by the page, so this file does not import it. */
  connectedApps?: ReactNode;
}) {
  const { t, locale } = useI18n();
  const d = t.developers;
  const path = useChannelPath();
  const [tab, setTab] = useState<Tab>("keys");
  const [info, setInfo] = useState<Console | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [paidTick, setPaidTick] = useState(0);

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

  const refreshPayments = useCallback(() => setPaidTick((n) => n + 1), []);
  const top = useTopUp(orgId, topup, load, refreshPayments);

  // An old link (#billing, #limits, ?tab=overview …) opens the tab that holds that now.
  useEffect(() => {
    const apply = () => {
      const asked = tabFromAddress(window.location.search, window.location.hash);
      if (asked) setTab(asked);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  function pick(next: Tab) {
    setTab(next);
    try {
      const params = new URLSearchParams(window.location.search);
      params.delete("tab");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}#${next}`);
    } catch {
      // the address is a convenience; the tab has changed regardless
    }
  }

  // Arrow keys move between tabs, as in a tab list.
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, from: Tab) {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(TABS.indexOf(from) + step + TABS.length) % TABS.length];
    pick(next);
    document.getElementById(`dev-tab-${next}`)?.focus();
  }

  // Reserve what the console measures once loaded (about 700px on a phone, 260px from lg up), so what
  // follows it on the page does not jump when it arrives.
  if (state !== "ready" || !info) {
    return (
      <div className="rhythm">
        <BalanceStrip info={null} loading={state === "loading"} locale={locale} topup={topup} top={top} />
        {state === "loading" ? (
          <div className="panel min-h-[700px] p-5 text-sm text-[var(--color-muted)] sm:p-6 lg:min-h-[260px]">…</div>
        ) : (
          <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{state === "missing" ? d.notMigrated : d.loadFailed}</div>
        )}
        {/* The connected apps do not depend on the API being set up: still reachable. */}
        {state !== "loading" ? connectedApps : null}
      </div>
    );
  }

  const tabs: [Tab, string][] = [
    ["keys", d.tabKeys],
    ["usage", d.tabUsage],
    ["apps", d.tabApps],
  ];

  return (
    <div className="rhythm">
      <BalanceStrip info={info} loading={false} locale={locale} topup={topup} top={top} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" className="flex flex-wrap gap-1.5">
          {tabs.map(([k, label]) => (
            <button
              key={k}
              id={`dev-tab-${k}`}
              role="tab"
              aria-selected={tab === k}
              aria-controls={`dev-panel-${k}`}
              tabIndex={tab === k ? 0 : -1}
              type="button"
              onClick={() => pick(k)}
              onKeyDown={(e) => onTabKey(e, k)}
              className={`pill px-4 text-sm ${tab === k ? "btn-sky is-solid" : "btn-sky"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <a href="/docs/api" target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-sm underline">
          {d.docsLink}
        </a>
      </div>

      {!info.activated_at ? (
        <Activate orgId={orgId} info={info} onDone={load} creditsHref={path("credits")} />
      ) : null}

      <div role="tabpanel" id={`dev-panel-${tab}`} aria-labelledby={`dev-tab-${tab}`}>
        {tab === "keys" && <Keys orgId={orgId} activated={!!info.activated_at} />}
        {tab === "usage" && <UsageAndBilling orgId={orgId} info={info} locale={locale} onSaved={load} reloadKey={paidTick} />}
        {tab === "apps" && connectedApps}
      </div>
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
    <div className="panel flex flex-col gap-3 p-5 sm:p-6">
      <h2 className="t-section">{d.activateTitle}</h2>
      <p className="text-sm text-[var(--color-muted)]">{d.activateBody}</p>
      {!info.eligible ? (
        <p className="text-sm">
          {d.notEligible}{" "}
          <Link className="underline" href={creditsHref}>
            {d.buyCredits}
          </Link>
        </p>
      ) : (
        <>
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} className="mt-0.5 size-5 shrink-0" />
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
              className="btn-sky is-solid pill px-5 text-sm disabled:opacity-40"
            >
              {busy ? d.activating : d.activate}
            </button>
          </div>
        </>
      )}
      {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="panel flex flex-col gap-1 p-5 sm:p-6">
      <span className="text-sm text-[var(--color-muted)]">{label}</span>
      <span className="text-[20px] font-semibold tabular-nums">{value}</span>
      {sub ? <span className="text-sm text-[var(--color-muted)]">{sub}</span> : null}
    </div>
  );
}

/** The usage tab: the account's figures, its monthly limit, the last 30 days and the payments — what Overview, Usage, Billing and Limits were. */
function UsageAndBilling({
  orgId,
  info,
  locale,
  onSaved,
  reloadKey,
}: {
  orgId: string;
  info: Console;
  locale: string;
  onSaved: () => void;
  reloadKey: number;
}) {
  return (
    <div className="rhythm">
      <Overview info={info} locale={locale} />
      <Limits orgId={orgId} info={info} onSaved={onSaved} />
      <UsageTab orgId={orgId} locale={locale} />
      <Billing orgId={orgId} reloadKey={reloadKey} />
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
    <div className="flex flex-col gap-3">
      {info.activated_at && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-muted)]">
          <StatusPill tone="ok" label={fmt(d.activeSince, { date: new Date(info.activated_at).toLocaleDateString(locale) })} />
          {info.exempt && <span>{d.exemptNote}</span>}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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

/** The words for a scope, from the dictionary (never inline: en, ru, uz). */
function scopeLabel(d: Record<string, string>, scope: ApiScope): string {
  const word: Record<ApiScope, string> = {
    "account:read": d.scopeAccountRead,
    "videos:read": d.scopeVideosRead,
    "videos:write": d.scopeVideosWrite,
    "creative:quote": d.scopeCreativeQuote,
    "creative:create": d.scopeCreativeCreate,
    "creative:read": d.scopeCreativeRead,
  };
  return word[scope];
}

/** A key's access as a short label: a preset's name, else "Custom (n)". A key made before generations reads as the default set. */
function accessLabel(d: Record<string, string>, fmt: (s: string, v: Record<string, string | number>) => string, scopes: readonly ApiScope[]): string {
  const preset = keyPresetOf(scopes);
  return preset === "full" ? d.presetFull : preset === "read" ? d.presetRead : fmt(d.presetCustom, { n: scopes.length });
}

/** What a listed key may do: a key made before generations reads as the default set. */
const scopesOf = (k: KeyRow) => effectiveScopes(k.scopes);

const FIELD =
  "min-h-11 min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-base text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]";
const CELL = "block py-1 md:table-cell md:py-2 md:pr-3 before:mr-2 before:text-[var(--color-muted)] before:content-[attr(data-label)] md:before:content-none";

export function Keys({ orgId, activated }: { orgId: string; activated: boolean }) {
  const { t, locale, fmt } = useI18n();
  const d = t.developers;
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [keysFailed, setKeysFailed] = useState(false);
  const [name, setName] = useState("");
  const [limitText, setLimitText] = useState("");
  // New keys start with what every key could always do (the "Full access" preset); spending credits
  // on generations is something the admin ticks on purpose, under "More options".
  const [scopes, setScopes] = useState<ApiScope[]>([...KEY_PRESETS.full]);
  const [rpmText, setRpmText] = useState("");
  const [creditText, setCreditText] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    if (!supabase) return;
    let { data, error: readErr } = (await supabase.from("api_keys").select(API_KEY_LIST_COLUMNS).eq("org_id", orgId).order("created_at", { ascending: false })) as {
      data: unknown;
      error: { message?: string } | null;
    };
    // Before migration 0062 the scope columns do not exist: list the keys by
    // what they always had (they read as made before generations) rather than fail.
    if (readErr) {
      ({ data, error: readErr } = await supabase.from("api_keys").select(API_KEY_BASE_COLUMNS).eq("org_id", orgId).order("created_at", { ascending: false }));
    }
    // A failed read is not "no keys".
    setKeysFailed(Boolean(readErr));
    setKeys(readErr ? null : ((data as Partial<KeyRow>[] | null) ?? []).map((k) => ({ scopes: null, rpm_limit: null, creative_monthly_credits: null, ...k }) as KeyRow));
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const active = (keys ?? []).filter((k) => !k.revoked_at).length;
  const preset = keyPresetOf(scopes);

  async function create() {
    const supabase = createClient();
    const clean = name.trim();
    const limit = parseLimitDollars(limitText);
    if (!supabase || busy || !clean) return;
    // What went wrong is in "More options": open it so the field is in view.
    const fail = (message: string) => {
      setMoreOpen(true);
      setError(message);
    };
    if (!limit.ok) return fail(d.limitInvalid);
    const rpm = parseRpmLimit(rpmText);
    if (!rpm.ok) return fail(d.rpmInvalid);
    const credits = parseCreditLimit(creditText);
    if (!credits.ok) return fail(d.creditLimitInvalid);
    if (scopes.length === 0) return fail(d.scopesRequired);
    setBusy(true);
    setError(null);
    const { data, error: e } = await supabase.rpc(
      "create_scoped_api_key",
      createScopedKeyArgs(orgId, clean, limit.cents, scopes, rpm.value, credits.value),
    );
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
    setRpmText("");
    setCreditText("");
    setScopes([...KEY_PRESETS.full]);
    setMoreOpen(false);
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

  if (!activated) return <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{d.activateFirst}</div>;

  const presets: [keyof typeof KEY_PRESETS, string, string][] = [
    ["full", d.presetFull, d.presetFullHint],
    ["read", d.presetRead, d.presetReadHint],
  ];

  return (
    <div className="rhythm">
      {shown && (
        <div className="panel flex flex-col gap-3 border-[var(--color-primary)] p-5 sm:p-6">
          <h2 className="t-section">{d.newKeyTitle}</h2>
          <p className="text-sm text-[var(--color-muted)]">{d.newKeyNote}</p>
          <code className="mono break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-sm">{shown}</code>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-sky pill px-4 text-sm"
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
            <button type="button" className="btn-sky is-solid pill px-4 text-sm" onClick={() => setShown(null)}>
              {d.done}
            </button>
          </div>
        </div>
      )}

      <form
        className="panel flex flex-col gap-4 p-5 sm:p-6"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label className="flex flex-col gap-1 text-sm text-[var(--color-muted)]">
          {d.keyName}
          <input className={FIELD} value={name} maxLength={60} placeholder={d.keyNamePh} onChange={(e) => setName(e.target.value)} />
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm text-[var(--color-muted)]">{d.keyAccess}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {presets.map(([id, label, hint]) => (
              <label
                key={id}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[var(--ns-r-key)] border-2 border-[var(--color-border)] p-3 has-[:checked]:border-[var(--color-primary)] has-[:checked]:bg-[var(--ns-key)]"
              >
                <input
                  type="radio"
                  name="key-access"
                  className="mt-1 size-5 shrink-0"
                  checked={preset === id}
                  onChange={() => setScopes([...KEY_PRESETS[id]])}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="text-base font-semibold">{label}</span>
                  <span className="text-sm text-[var(--color-muted)]">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          {preset === null && (
            <p className="text-sm">
              <strong>{fmt(d.presetCustom, { n: scopes.length })}</strong> {d.presetCustomHint}
            </p>
          )}
        </fieldset>

        <details open={moreOpen} onToggle={(e) => setMoreOpen(e.currentTarget.open)} className="group flex flex-col">
          <summary className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 text-sm font-medium underline-offset-4 hover:underline">
            {d.moreOptions}
            <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-2 flex flex-col gap-4">
            <fieldset className="flex flex-col">
              <legend className="mb-1 text-sm text-[var(--color-muted)]">{d.keyScopes}</legend>
              {API_SCOPES.map((scope) => (
                <label key={scope} className="flex min-h-11 items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    className="size-5 shrink-0"
                    checked={scopes.includes(scope)}
                    onChange={(e) => setScopes((cur) => (e.target.checked ? [...cur, scope] : cur.filter((x) => x !== scope)))}
                  />
                  <span>{scopeLabel(d, scope)}</span>
                </label>
              ))}
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm text-[var(--color-muted)]">
                {d.keyLimit}
                <input className={FIELD} value={limitText} inputMode="decimal" onChange={(e) => setLimitText(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-sm text-[var(--color-muted)]">
                {d.keyRpm}
                <input className={FIELD} value={rpmText} inputMode="numeric" onChange={(e) => setRpmText(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-sm text-[var(--color-muted)] sm:col-span-2">
                {d.keyCreditLimit}
                <input className={FIELD} value={creditText} inputMode="decimal" onChange={(e) => setCreditText(e.target.value)} />
              </label>
            </div>
          </div>
        </details>

        <div>
          <button
            type="submit"
            disabled={busy || !name.trim() || scopes.length === 0 || active >= MAX_ACTIVE_KEYS}
            className="btn-sky is-solid pill px-5 text-sm disabled:opacity-40"
          >
            {busy ? d.creating : d.create}
          </button>
        </div>
        {active >= MAX_ACTIVE_KEYS && <p className="text-sm text-[var(--color-muted)]">{d.keyLimitReached}</p>}
        {error && <p className="text-sm text-[var(--color-fail)]">{error}</p>}
      </form>

      <div className="panel p-5 sm:p-6">
        {keysFailed ? (
          <ErrorState compact onRetry={load} />
        ) : keys === null ? (
          <p className="text-sm text-[var(--color-muted)]">…</p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">{d.noKeys}</p>
        ) : (
          <table className="block w-full text-left text-sm md:table">
            <thead className="sr-only md:table-header-group md:not-sr-only text-[var(--color-muted)]">
              <tr>
                <th className="py-1 pr-3">{d.keyName}</th>
                <th className="py-1 pr-3">{d.keyId}</th>
                <th className="py-1 pr-3">{d.lastUsed}</th>
                <th className="py-1 pr-3">{d.keyAccess}</th>
                <th className="py-1 pr-3">{d.keyLimitShort}</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody className="block divide-y divide-[var(--color-border)] md:table-row-group">
              {keys.map((k) => (
                <tr key={k.id} className={`block py-3 md:table-row md:py-0 ${k.revoked_at ? "opacity-50" : ""}`}>
                  <td className="block py-1 md:table-cell md:py-2 md:pr-3">
                    <span className="block text-base font-medium md:text-sm md:font-normal">{k.name}</span>
                    <span className="block text-sm text-[var(--color-muted)]">{`${d.created}: ${new Date(k.created_at).toLocaleDateString(locale)}`}</span>
                  </td>
                  <td className="mono block break-all py-1 text-sm md:table-cell md:py-2 md:pr-3">{k.id}</td>
                  <td className={CELL} data-label={`${d.lastUsed}:`}>
                    {k.last_used_at ? new Date(k.last_used_at).toLocaleString(locale) : d.never}
                  </td>
                  <td className="block py-1 md:table-cell md:py-0 md:pr-3">
                    <details className="group">
                      <summary
                        className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 text-sm underline-offset-4 hover:underline"
                        title={scopesOf(k).map((x) => scopeLabel(d, x)).join(" · ")}
                      >
                        {accessLabel(d, fmt, scopesOf(k))}
                        <ChevronDown aria-hidden className="size-4 transition-transform group-open:rotate-180" />
                      </summary>
                      <ul className="mb-2 flex list-disc flex-col gap-0.5 pl-5 text-sm">
                        {scopesOf(k).map((x) => (
                          <li key={x}>{scopeLabel(d, x)}</li>
                          ))}
                        </ul>
                        {k.scopes === null && <p className="mb-1 text-sm text-[var(--color-muted)]">{d.keyAccessLegacy}</p>}
                        <p className="mb-1 text-sm text-[var(--color-muted)]">{`${d.keyRpmShort}: ${k.rpm_limit ?? d.noLimit}`}</p>
                        <p className="mb-1 text-sm text-[var(--color-muted)]">{`${d.keyCreditsShort}: ${k.creative_monthly_credits ?? d.noLimit}`}</p>
                      </details>
                    </td>
                    <td className={CELL} data-label={`${d.keyLimitShort}:`}>
                      {k.monthly_limit_cents === null ? d.noLimit : formatUsd(k.monthly_limit_cents, locale)}
                    </td>
                    <td className="block py-1 md:table-cell md:py-2 md:text-right">
                      {k.revoked_at ? (
                        <span className="text-sm">{d.revoked}</span>
                      ) : (
                        <span className="flex flex-wrap gap-2 md:justify-end">
                          <button type="button" className="btn-quiet px-3! text-sm" onClick={() => setKeyLimit(k)}>
                            {d.setLimit}
                          </button>
                          <button type="button" className="btn-quiet px-3! text-sm" onClick={() => revoke(k)}>
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
    <div className="panel flex flex-col gap-2 p-5 sm:p-6">
      <span className="text-sm text-[var(--color-muted)]">{label}</span>
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
      <div className="flex justify-between text-sm text-[var(--color-muted)]">
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

  if (failed) return <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{d.loadFailed}</div>;
  if (!usage) return <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">…</div>;
  const total = usage.days.reduce((s, x) => s + x.requests, 0);
  return (
    <div className="rhythm">
      <h2 className="t-section">{d.usageTitle}</h2>
      {total === 0 ? (
        <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{d.noUsage}</div>
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
          <div className="panel overflow-x-auto p-5 sm:p-6">
            <table className="w-full text-left text-sm">
              <thead className="text-sm text-[var(--color-muted)]">
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

/** Payment history. Starting a payment is the "Add funds" button beside the balance; reloadKey reads the list again while a payment lands. */
export function Billing({ orgId, reloadKey = 0 }: { orgId: string; reloadKey?: number }) {
  const { t, locale } = useI18n();
  const d = t.developers;
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [rowsFailed, setRowsFailed] = useState(false);

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
  }, [loadHistory, reloadKey]);

  const kindLabel = { topup: d.kindTopup, refund: d.kindRefund, adjustment: d.kindAdjustment };

  return (
    <div className="panel overflow-x-auto p-5 sm:p-6">
      <h2 className="t-section mb-2">{d.historyTitle}</h2>
      {rowsFailed ? (
        <ErrorState compact onRetry={loadHistory} />
      ) : rows === null ? (
        <p className="text-sm text-[var(--color-muted)]">…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">{d.noPayments}</p>
      ) : (
        <table className="w-full text-left text-sm">
          <tbody className="divide-y divide-[var(--color-border)]">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="py-2 pr-3">{new Date(r.created_at).toLocaleString(locale)}</td>
                <td className="py-2 pr-3">{kindLabel[r.kind]}</td>
                <td className="py-2 pr-3 tabular-nums">{formatUsd(r.amount_cents, locale)}</td>
                <td className="py-2 text-right">
                  {r.kind === "topup" && r.external_id?.startsWith("txn_") ? (
                    <a
                      className="inline-flex min-h-11 items-center text-sm underline"
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

  if (!info.activated_at) return <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{d.activateFirst}</div>;
  return (
    <div className="panel flex flex-col gap-3 p-5 sm:p-6">
      <h2 className="t-section">{d.limitsTitle}</h2>
      <p className="text-sm text-[var(--color-muted)]">
        {info.tier_cap_cents === null ? d.noLimit : fmt(d.limitsBody, { cap: formatUsd(info.tier_cap_cents, locale) })}
      </p>
      {info.tier_cap_cents !== null && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-[var(--color-muted)]">
            {d.orgLimit}
            <input
              className="min-h-11 w-40 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-base text-[var(--color-fg)] outline-none focus:border-[var(--color-primary)]"
              value={text}
              inputMode="decimal"
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <button type="button" onClick={save} className="btn-sky is-solid pill px-5 text-sm">
            {d.save}
          </button>
        </div>
      )}
      {msg && <p className="text-sm">{msg}</p>}
    </div>
  );
}
