import { PageHeader } from "@/components/PageHeader";
import { MarketingBoard } from "@/components/marketing/MarketingBoard";
import { ErrorState } from "@/components/ReadError";
import { StateBlock } from "@/components/states/StateBlock";
import { getDictionary } from "@/lib/i18n/server";
import { guardOperatorPage } from "@/lib/auth/org-roles";
import { createClient } from "@/lib/supabase/server";
import { marketingPostsOn, marketingTargets, readMarketing } from "@/lib/server/marketing";
import { readOwnerSecurity } from "@/lib/server/owner-reads";
import "../../app-pages-g5.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Marketing posts — the owner approves what goes to the public Telegram channel (migration 0108, docs/MARKETING_POSTS.md).
 *
 * Behind NIGHTSHIFT_MARKETING_POSTS (exactly `on`). While it is not, the page is an "off" note and makes NO read: no
 * database call, nothing new on screen. The operator guard runs first either way (signed out -> /login, anyone else ->
 * 404, a missing second step -> the code page), so the note itself is not shown to a stranger.
 *
 * On, it reads as the signed-in owner (the anon key and their session; no service key): the settings (owner_marketing_get)
 * and the newest posts. A read that fails says so and offers Retry; migration 0108 not applied says that. Nothing here sends,
 * re-sends or tests a post; the worker posts after an approval, only while the poster is on.
 */
export default async function MarketingPage() {
  await guardOperatorPage();
  const { t } = await getDictionary();
  const m = t.marketing;
  const head = <PageHeader icon="marketing" title={m.title} subtitle={m.subtitle} />;

  if (!marketingPostsOn()) {
    return (
      <div className="rhythm ns-open g5-page">
        {head}
        <StateBlock tone="idle" title={m.off.title}>
          {m.off.body}
        </StateBlock>
      </div>
    );
  }

  const supabase = await createClient();
  const read = supabase ? await readMarketing(supabase) : ({ state: "failed" } as const);
  // Read only: is the database's second-factor gate (0107) on? Approving makes a post public, and with the gate off a
  // password-only session could. Unreadable is "unknown", never "off" (owner_security_get, the same read as the Security page).
  const security = supabase && read.state === "ok" ? await readOwnerSecurity(supabase) : null;
  const gateOn = security && security.state === "ok" ? security.value.gateOn : null;
  const { channel, origin } = marketingTargets();

  return (
    <div className="rhythm ns-open g5-page">
      {head}
      {read.state === "unsupported" ? (
        <StateBlock tone="warn" title={m.title}>
          {m.unsupported}
        </StateBlock>
      ) : read.state === "failed" ? (
        <ErrorState message={m.failed} />
      ) : (
        <MarketingBoard
          settings={read.value.settings}
          posts={read.value.posts}
          truncated={read.value.truncated}
          channel={channel}
          origin={origin}
          nowMs={Date.now()}
          gateOn={gateOn}
        />
      )}
    </div>
  );
}
