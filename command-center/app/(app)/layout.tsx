import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SideNav } from "@/components/SideNav";
import { NeuralBackdrop } from "@/components/NeuralBackdrop";
import { Header } from "@/components/Header";
import { CommandPalette } from "@/components/CommandPalette";
import { getChannelContext } from "@/lib/channels-server";
import { getOrgContext } from "@/lib/orgs-server";
import { isSupabaseConfigured } from "@/lib/config";
import { WELCOME_PATH } from "@/lib/public-paths";
import {
  ALL_CHANNELS,
  ALL_CHANNELS_SLUG,
  PATH_HEADER,
  SEARCH_HEADER,
  appRedirect,
  channelSlug,
  unscopedScope,
} from "@/lib/channels";
import { NavigationProvider } from "@/components/navigation/NavigationProvider";
import { ScrollToTop } from "@/components/navigation/ScrollToTop";
import { createClient, getUser } from "@/lib/supabase/server";
import { isOperator } from "@/lib/auth/org-roles";
import { readCreditAccount } from "@/lib/server/credits";
import { planValue, readBillingSummary } from "@/lib/server/plans";
import { accountPlan, type AccountPlan } from "@/lib/account";
import type { CreditAccount } from "@/lib/credits";
import { ShellProvider } from "@/components/shell/ShellContext";
import { AppProviders } from "@/components/AppProviders";
import { getLocale } from "@/lib/i18n/server";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // No backend means no account and nothing to show. A built site then answers
  // every app URL — /blog as much as /chronos/videos — with the public 404, so
  // a visitor never meets setup copy, env-var names or the app's frame. Only
  // `next dev` keeps the setup notice (NotConfigured), for whoever is wiring it up.
  if (!isSupabaseConfigured && process.env.NODE_ENV === "production") notFound();

  const org = isSupabaseConfigured
    ? await getOrgContext()
    : { supported: false, orgs: [], current: null };

  // Signed in, organizations exist (0018 applied), and this account belongs to
  // none: a new sign-up. Nothing in the app would show them anything — RLS
  // returns no rows — so they are sent to first-run onboarding, which starts
  // with creating their organization.
  if (org.supported && org.orgs.length === 0) redirect(WELCOME_PATH);

  // Channels for the switcher. Empty before the Phase 5 migration is applied,
  // in which case the switcher renders nothing and the app looks as it did.
  const { channels, selection, slug: honest, scope } = isSupabaseConfigured
    ? await getChannelContext()
    : { channels: [], selection: ALL_CHANNELS, slug: ALL_CHANNELS_SLUG, scope: unscopedScope() };

  // Keep the address bar honest, in both directions. A URL naming a channel
  // that does not exist (deleted, mistyped, or not visible to this user) — or
  // that belongs to another organization, even one a platform admin can read —
  // resolves to every channel of the current organization, and says so. A URL naming the channel by its
  // internal id — /default/pipeline — resolves fine, and is rewritten to the
  // name the operator actually knows it by: /chronos/pipeline.
  //
  // And the app is one workspace for everyone but the platform operator: no
  // every-channel roll-up (their first channel instead), and no operator-only
  // section (their Command Center instead). See appRedirect in lib/channels.
  const operator = await isOperator();
  const headerStore = await headers();
  const path = headerStore.get(PATH_HEADER);
  if (path) {
    const to = appRedirect({
      path,
      search: headerStore.get(SEARCH_HEADER) ?? "",
      honestSlug: honest,
      selection,
      channels,
      operator,
    });
    if (to) redirect(to);
  }
  const email = isSupabaseConfigured ? ((await getUser())?.email ?? null) : null;

  // Credits in the header, for an organization that pays. The operator's own
  // (default) organization is exempt and shows none; so does a database
  // without migration 0020 — never a made-up zero.
  // The plan beside them (0034's billing_summary) names the plan on the
  // sidebar's user card and in the credit menu; unreadable is unknown, and an
  // unknown plan is left unnamed rather than called Free. Both reads are the
  // member's own session (RLS), read-only.
  let credits: CreditAccount | null = null;
  let plan: AccountPlan | null = null;
  if (org.supported && org.current && !org.current.is_default) {
    const supabase = await createClient();
    if (supabase) {
      const orgId = org.current.id;
      const [res, summary] = await Promise.all([
        readCreditAccount(supabase, orgId).catch(() => null),
        readBillingSummary(supabase, orgId).catch(() => ({ state: "failed" as const })),
      ]);
      credits = res?.account ?? null;
      plan = accountPlan(planValue(summary), false);
    }
  } else if (org.supported && org.current?.is_default) {
    plan = { kind: "exempt" };
  }

  // The breadcrumb names a channel the way the switcher does, by its name — the
  // URL carries a slug, which is not always the name the operator gave it.
  const channelNames = Object.fromEntries(
    channels.map((c) => [channelSlug(c, channels), c.name || c.channel_id]),
  );

  const header = (
    <Header
      channels={channels}
      selection={selection}
      orgs={org.orgs}
      currentOrgId={org.current?.id ?? null}
      credits={credits}
      scope={scope}
      email={email}
      operator={operator}
      plan={plan}
    />
  );

  return (
    <AppProviders locale={await getLocale()}>
      <NavigationProvider channelNames={channelNames}>
        <ShellProvider operator={operator}>
          <div className="app-shell atmos relative flex min-h-dvh flex-col">
            <NeuralBackdrop dim />
            {operator ? (
              <div className="relative z-10 flex min-h-dvh flex-col">
                {header}
                <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                  <SideNav operator />
                  <main className="pad-page min-w-0 flex-1">{children}</main>
                </div>
              </div>
            ) : (
              // A customer's frame, as creative apps draw it: the sidebar full
              // height on the left, the top bar and the page to its right. On a
              // phone the sidebar gives way to the bottom tab bar, and the page
              // keeps its end above it.
              <div className="relative z-10 flex min-h-dvh">
                <SideNav email={email} plan={plan} />
                <div className="flex min-w-0 flex-1 flex-col">
                  {header}
                  <main className="pad-page min-w-0 flex-1 pb-24 lg:pb-10">{children}</main>
                </div>
              </div>
            )}
            <CommandPalette scope={scope} operator={operator} />
            <ScrollToTop />
          </div>
        </ShellProvider>
      </NavigationProvider>
    </AppProviders>
  );
}
