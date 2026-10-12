"use client";

import Link from "next/link";
import { Gift, LogOut } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { LanguageSelector } from "@/components/LanguageSelector";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ViewModeToggle } from "@/components/view-mode/ViewModeToggle";
import { useChannelPath } from "@/lib/channels-client";
import { AvatarUploader } from "@/components/account/AvatarUploader";
import { ConnectedAccountsList, planDetail, planLabel, useAccountSummary, useSignOut } from "@/components/account/AccountParts";

/**
 * Settings → Account: who is signed in, the plan, the publishing accounts
 * connected to the workspace, the language and the theme, and the way out.
 *
 * It is the phone's account. The bottom bar's last tab is the account (the
 * initial, as Instagram's profile tab), so what the old round button in the
 * top bar held lives here: nothing that was reachable from it is only
 * reachable from a sidebar the phone does not have. From `lg` up the sidebar's
 * user card remains and this is simply the same facts on the page.
 *
 * The numbers are GET /api/account (the member's own session, read-only), read
 * once on arrival; a value that did not come back reads "—", never a guess.
 */
export function AccountSection({ email, avatarV = null }: { email: string | null; avatarV?: number | null }) {
  const { t, locale } = useI18n();
  const path = useChannelPath();
  const signOut = useSignOut();
  const { data, state } = useAccountSummary(true);
  const dash = t.common.dash;
  const shownEmail = data?.email ?? email;
  const detail = state === "ready" && data ? planDetail(data.plan, t, locale) : null;

  return (
    <section className="panel flex flex-col gap-6 p-5 sm:p-6" aria-labelledby="account-title" aria-busy={state === "loading"}>
      <div>
        <h2 id="account-title" className="t-section">
          {t.account.title}
        </h2>
        <p className="g5-sub">{t.account.sectionSub}</p>
      </div>

      {state === "failed" && (
        <p role="status" className="text-xs text-[var(--color-warn)]">
          {t.account.loadFailed}
        </p>
      )}

      {/* The profile photo: add, change or remove. It reads the version the page already has (the layout's user). */}
      <AvatarUploader email={shownEmail} version={avatarV} />

      <dl className="grid gap-5 border-t border-[var(--ns-rule)] pt-5 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="text-xs text-[var(--color-muted)]">{t.account.signedInAs}</dt>
          <dd className="mt-1 break-words text-[15px] text-[var(--color-fg)]" data-testid="account-email">
            {shownEmail ?? dash}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-[var(--color-muted)]">{t.account.plan}</dt>
          <dd className="mt-1 text-[15px] text-[var(--color-fg)]" data-testid="account-plan">
            {state === "ready" && data ? planLabel(data.plan, t) : state === "loading" ? t.account.loading : dash}
            {detail && <span className="mt-0.5 block text-xs text-[var(--color-muted)]">{detail}</span>}
          </dd>
        </div>
      </dl>

      {/* The phone's way to the invite card on Credits (the old account panel's "Invite friends"). The operator's own
          organization has no invite card, so it gets no shortcut once the plan is known. */}
      {!(state === "ready" && data?.plan.kind === "exempt") && (
        <div className="border-t border-[var(--ns-rule)] pt-5">
          <Link href={path("/credits") + "#invite"} className="side-link -mx-3" data-testid="account-invite">
            <Gift aria-hidden className="size-[18px] shrink-0" strokeWidth={1.75} />
            <span>{t.account.inviteFriends}</span>
          </Link>
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-[var(--ns-rule)] pt-5">
        <h3 className="text-xs text-[var(--color-muted)]">{t.account.accounts}</h3>
        <ConnectedAccountsList data={data} state={state} />
      </div>

      <div className="flex flex-col gap-3 border-t border-[var(--ns-rule)] pt-5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-[var(--color-fg)]">{t.common.language}</span>
          <LanguageSelector />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-[var(--color-fg)]">{t.common.theme}</span>
          <ThemeToggle showLabel />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-[var(--color-fg)]">{t.common.view}</span>
          <ViewModeToggle showLabel />
        </div>
      </div>

      <div className="border-t border-[var(--ns-rule)] pt-5">
        <button type="button" onClick={signOut} className="btn-quiet inline-flex items-center gap-2 px-5 text-sm">
          <LogOut aria-hidden className="size-4" strokeWidth={1.75} />
          {t.common.signOut}
        </button>
      </div>
    </section>
  );
}
