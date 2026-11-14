import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { getDictionary } from "@/lib/i18n/server";
import { readMyReferrals } from "@/lib/server/referrals";
import { inviteWorthShowing, type MyInvite } from "@/lib/friend-invites";
import type { InviteRead } from "@/lib/server/friend-invites";
import { ReferralCard } from "@/components/credits/ReferralCard";
import { InviteFriendsCard } from "@/components/credits/InviteFriendsCard";
import { ErrorState } from "@/components/ReadError";

/**
 * The Credits page's "Invite friends" section, rendered inside a Suspense boundary: claim_referral_rewards() settles the
 * person's own referrals in the database before it answers, and the rest of the page does not wait for it.
 *
 *   0165 applied   the referral card (the link, Share, the terms line, the person's own counts), or one line while the
 *                  programme is closed and there is no link yet, or the read error with Retry;
 *   0165 missing   0092's card exactly as before (`legacy`): the database still runs 0092's rules, so its card is the true one.
 */
export async function ReferralSection({ orgId, legacy }: { orgId: string; legacy: InviteRead<MyInvite> }) {
  const [{ t }, supabase, h] = await Promise.all([getDictionary(), createClient(), headers()]);
  // A router prefetch renders this too: it reads, and only a real visit settles.
  const prefetch = h.get("next-router-prefetch") !== null || h.get("purpose") === "prefetch";
  const read = supabase ? await readMyReferrals(supabase, { settle: !prefetch }) : ({ state: "failed" } as const);

  if (read.state === "unsupported") {
    if (legacy.state === "ok" && inviteWorthShowing(legacy.value)) return <InviteFriendsCard invite={legacy.value} orgId={orgId} />;
    if (legacy.state === "ok") return <ClosedLine title={t.invite.title} body={t.invite.closedShort} />;
    if (legacy.state === "failed") return <Failed title={t.invite.title} message={t.invite.readFailed} />;
    return null;
  }
  if (read.state === "failed") return <Failed title={t.referral.title} message={t.referral.readFailed} />;
  // Closed and no link yet: a disabled "Create my link" would be a button nobody can act on. The line keeps #invite, which
  // the account menu links to.
  if (!read.value.enabled && !read.value.link) return <ClosedLine title={t.referral.title} body={t.referral.closedShort} />;
  return <ReferralCard referrals={read.value} orgId={orgId} />;
}

function ClosedLine({ title, body }: { title: string; body: string }) {
  return (
    <section id="invite" className="flex scroll-mt-7 flex-col gap-1" aria-labelledby="invite-title" data-invite-closed>
      <h2 id="invite-title" className="t-section">
        {title}
      </h2>
      <p className="text-sm text-[var(--color-muted)]">{body}</p>
    </section>
  );
}

function Failed({ title, message }: { title: string; message: string }) {
  return (
    <section id="invite" className="panel flex scroll-mt-7 flex-col gap-2 p-5 sm:p-6" aria-labelledby="invite-title" data-referral-failed>
      <h2 id="invite-title" className="t-section">
        {title}
      </h2>
      <ErrorState compact message={message} />
    </section>
  );
}
