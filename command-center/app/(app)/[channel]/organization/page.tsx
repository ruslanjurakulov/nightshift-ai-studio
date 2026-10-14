import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { getOrgContext } from "@/lib/orgs-server";
import { createClient, getUser } from "@/lib/supabase/server";
import { readMyInvite } from "@/lib/server/friend-invites";
import { inviteCardShown } from "@/lib/credits";
import { getDictionary } from "@/lib/i18n/server";
import { getChannelPath } from "@/lib/channels-path-server";
import { AccountSection } from "@/components/account/AccountSection";
import { AccountSecurity } from "@/components/account/AccountSecurity";
import { readOwnHandle } from "@/lib/server/handles";
import { pendingHandleFrom } from "@/lib/handles";
import { avatarVersionFromMetadata } from "@/lib/avatar";
import { NotificationChannels } from "@/components/notifications/NotificationChannels";
import { customerBotUsername, readChannels } from "@/lib/server/notify-channels";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Settings: Account (who is signed in, plan, publishing accounts, language,
 * theme, sign out), Account and security (sign-in email, password, @username)
 * and the way to Developers (API keys). The phone's bottom bar ends in this
 * page as its account tab, so the account lives first, here.
 *
 * There are two kinds of people in this product: a signed-in user, who owns
 * their workspace and does everything in it, and the platform operator, who
 * also sees the operator pages. So there is no team here: no roles, no
 * invitations, no members table. The workspace is named once, on /welcome, and
 * is not edited here. Which workspace is "current" is decided on the server
 * (lib/orgs-server.ts) from the caller's own memberships; before migration 0018
 * this page says so rather than showing an empty form.
 */
export default async function SettingsPage() {
  const { t } = await getDictionary();
  const [org, user, path, handles] = await Promise.all([getOrgContext(), getUser(), getChannelPath(), readOwnHandle()]);

  // The photo's cache-buster from the user already read above (no extra request); untrusted, see lib/avatar.ts.
  // The "Invite friends" row appears exactly when the Credits page draws the invite card (one predicate).
  const supabase = user && org.supported && org.current ? await createClient() : null;
  const showInvite = supabase && org.current ? inviteCardShown(org.current, (await readMyInvite(supabase)).state) : false;
  const avatarV = avatarVersionFromMetadata(user?.user_metadata);
  // Telegram notifications stay hidden until the customer bot is configured (its public username is set)
  // and migration 0102 is applied.
  const notify = user && org.supported && org.current && customerBotUsername() ? await readChannels() : null;

  return (
    <div className="rhythm ns-open">
      <PageHeader icon="organization" title={t.org.title} subtitle={t.org.customerSubtitle} />
      {!user ? (
        <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{t.org.signIn}</div>
      ) : !org.supported ? (
        <>
          <AccountSection email={user.email ?? null} avatarV={avatarV} showInvite={showInvite} />
          <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{t.org.notMigrated}</div>
        </>
      ) : org.current ? (
        <>
          <AccountSection email={user.email ?? null} avatarV={avatarV} showInvite={showInvite} />
          {user.email && (
            <AccountSecurity
              email={user.email}
              pendingEmail={user.new_email ?? null}
              handle={handles.row}
              signupHandle={pendingHandleFrom(user.user_metadata)}
              handlesSupported={handles.supported}
            />
          )}
          {notify?.supported && (
            <NotificationChannels initialChannels={notify.channels} initialPreferences={notify.preferences} />
          )}
          <div className="panel flex flex-col gap-3 p-5 sm:p-6">
            <h2 className="t-section">{t.org.developersTitle}</h2>
            <p className="text-sm text-[var(--color-muted)]">{t.org.developersHint}</p>
            <Link href={path("/developers")} className="btn-quiet self-start px-5 text-sm">
              {t.org.developersOpen}
            </Link>
          </div>
        </>
      ) : (
        <>
          <AccountSection email={user.email ?? null} avatarV={avatarV} showInvite={showInvite} />
          <div className="panel p-5 sm:p-6 text-sm text-[var(--color-muted)]">{t.org.noOrg}</div>
        </>
      )}
    </div>
  );
}
