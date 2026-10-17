"use client";

import Link from "next/link";
import { useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { I18nContext } from "@/lib/i18n/public-context";
import { fmt } from "@/lib/i18n";
import { clearAllCreateAttempts } from "@/lib/create-attempt-store";
import { clearAllEditorDrafts } from "@/lib/editor-draft-store";
import { useChannelPath } from "@/lib/channels-client";
import { AccountTile, PlatformTile } from "@/components/account/PlatformLogo";
import {
  coerceAccountSummary,
  type AccountPlan,
  type AccountSummary,
  type ConnectedAccount,
  type Platform,
} from "@/lib/account";
import { clearAllDrafts } from "@/lib/create-draft";
import { signOutThisBrowser } from "@/lib/sign-out";
import { useToast } from "@/components/feedback/ToastProvider";

/**
 * The pieces of the account panel that more than one place draws: the read of
 * GET /api/account, the plan lines, the connected publishing accounts and
 * sign out. The panel (AccountMenu: the sidebar card, the operator's bar) and
 * Settings → Account (AccountSection: the phone's way to the same things, now
 * that the bottom bar's last tab is the account) both use them, so what a
 * person is told about their plan or their channels cannot differ by where
 * they looked.
 */

type Dict = ReturnType<typeof useI18n>["t"];

export type SummaryState = "idle" | "loading" | "ready" | "failed";

/**
 * The signed-in user's own account summary (their session, RLS-scoped,
 * read-only). Reads when `active` turns true — the panel each time it opens,
 * Settings once on arrival — so a purchase or a finished run shows fresh
 * numbers. It never invents a value: `data` is null until a read succeeded.
 */
export function useAccountSummary(active: boolean): { data: AccountSummary | null; state: SummaryState } {
  const [data, setData] = useState<AccountSummary | null>(null);
  const [state, setState] = useState<SummaryState>("idle");
  useEffect(() => {
    if (!active) return;
    let live = true;
    setState("loading");
    fetch("/api/account", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const summary = coerceAccountSummary(await res.json());
        if (!summary) throw new Error("malformed");
        if (live) {
          setData(summary);
          setState("ready");
        }
      })
      .catch(() => {
        if (live) setState("failed");
      });
    return () => {
      live = false;
    };
  }, [active]);
  return { data, state };
}

/** Sign out of this browser, then to the sign-in page. One implementation for the panel and Settings. */
export function useSignOut(): () => Promise<void> {
  const router = useRouter();
  const toast = useToast();
  // Optional context: a few callers render this hook outside the app's provider, and the sentence below is only for the
  // rare case that nothing could sign this browser out.
  const i18n = useContext(I18nContext);
  return async function signOut() {
    const outcome = await signOutThisBrowser(createClient()?.auth);
    const message = i18n?.full ? i18n.t.ownerTruth.signOutFailed : "Could not reach the server to sign you out. Try again when you are online.";
    // Still signed in here (the session could not be removed): nothing of this person's is thrown away, and they are told.
    if (outcome === "failed") {
      toast.error(message);
      return;
    }
    // The create form's unfinished draft is this person's; it goes with the session.
    clearAllDrafts();
    clearAllCreateAttempts();
    clearAllEditorDrafts();
    // Signed out in this browser, but the server could not be reached to end the session there: say so before leaving.
    if (outcome === "cleared") {
      toast.error(message);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    router.push("/login");
    router.refresh();
  };
}

export function planLabel(plan: AccountPlan, t: Dict): string {
  switch (plan.kind) {
    case "plan":
      return plan.name;
    case "exempt":
      return t.account.planExempt;
    default:
      return t.common.dash;
  }
}

/** "Renews 1 Nov" / "Ends 1 Nov" / "Payment failed" under the plan name; null for Free. */
export function planDetail(plan: AccountPlan, t: Dict, locale: string): string | null {
  if (plan.kind !== "plan" || !plan.status) return null;
  if (plan.status === "past_due") return t.plans.status.past_due;
  if (!plan.periodEnd) return t.plans.status[plan.status];
  const date = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(plan.periodEnd));
  return plan.status === "canceled" || plan.cancelAtPeriodEnd ? fmt(t.plans.endsOn, { date }) : fmt(t.plans.renews, { date });
}

/**
 * The three publishing platforms, one row each: the accounts connected to the
 * workspace, or a placeholder saying what is missing. Before the data arrives
 * (or when it failed) nothing is claimed about any platform.
 */
export function ConnectedAccountsList({
  data,
  state,
  onNavigate,
}: {
  data: AccountSummary | null;
  state: SummaryState;
  onNavigate?: () => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {rows(state === "ready" ? (data?.accounts ?? []) : null).map((row) =>
        row.kind === "account" ? (
          <AccountRow key={`${row.account.platform}:${row.account.id}`} account={row.account} />
        ) : (
          <PlaceholderRow
            key={`p:${row.platform}`}
            platform={row.platform}
            connectable={
              row.platform === "youtube" || (state === "ready" && Boolean(data?.connectable[row.platform]))
            }
            status={state === "ready" ? "ready" : state === "failed" ? "failed" : "loading"}
            onNavigate={onNavigate}
          />
        ),
      )}
    </ul>
  );
}

const PLATFORMS: Platform[] = ["youtube", "instagram", "tiktok"];

type Row = { kind: "account"; account: ConnectedAccount } | { kind: "placeholder"; platform: Platform };

/** Real rows first, in platform order; a platform with none gets one placeholder. */
function rows(accounts: ConnectedAccount[] | null): Row[] {
  const out: Row[] = [];
  for (const platform of PLATFORMS) {
    const mine = (accounts ?? []).filter((a) => a.platform === platform);
    if (mine.length === 0) out.push({ kind: "placeholder", platform });
    else for (const account of mine) out.push({ kind: "account", account });
  }
  return out;
}

const PLATFORM_NAME: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };

function AccountRow({ account }: { account: ConnectedAccount }) {
  const { t } = useI18n();
  return (
    <li className="flex items-center gap-3 rounded-xl px-2 py-1.5">
      <AccountTile account={account} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-[var(--color-fg)]">{account.name}</p>
        <p className="text-xs text-[var(--color-muted)]">{PLATFORM_NAME[account.platform]}</p>
      </div>
      {account.connected ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--color-ok)]">
          <CircleCheck aria-hidden className="size-4" />
          {t.account.connected}
        </span>
      ) : (
        <span className="shrink-0 text-xs text-[var(--color-muted)]">{t.account.notConnected}</span>
      )}
    </li>
  );
}

function PlaceholderRow({
  platform,
  connectable,
  status,
  onNavigate,
}: {
  platform: Platform;
  /** Instagram / TikTok: the deployment has the platform's app keys (0028). */
  connectable: boolean;
  /** Before the data arrives, or when it failed, nothing is claimed about YouTube. */
  status: "loading" | "failed" | "ready";
  onNavigate?: () => void;
}) {
  const { t } = useI18n();
  const path = useChannelPath();
  const youtube = platform === "youtube";
  return (
    <li className="flex items-center gap-3 rounded-xl px-2 py-1.5">
      <PlatformTile platform={platform} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-[var(--color-fg)]">{PLATFORM_NAME[platform]}</p>
        <p className="text-xs text-[var(--color-muted)]">
          {!youtube
            ? connectable
              ? t.account.notConnected
              : t.account.comingSoon
            : status === "ready"
              ? t.account.noYoutube
              : status === "loading"
                ? t.account.loading
                : t.common.dash}
        </p>
      </div>
      {youtube || connectable ? (
        status === "ready" && (
          <Link href={path("/channels")} onClick={onNavigate} className="btn-sky is-quiet pill shrink-0 px-3 py-1 text-xs">
            {t.account.connect}
          </Link>
        )
      ) : (
        <button
          type="button"
          disabled
          aria-disabled="true"
          title={t.account.comingSoon}
          className="btn-sky is-quiet pill shrink-0 px-3 py-1 text-xs opacity-50"
        >
          {t.account.connect}
        </button>
      )}
    </li>
  );
}
