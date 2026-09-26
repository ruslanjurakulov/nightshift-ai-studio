import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SideNav } from "@/components/SideNav";
import { NeuralBackdrop } from "@/components/NeuralBackdrop";
import { Header } from "@/components/Header";
import { CommandPalette } from "@/components/CommandPalette";
import { getChannelContext } from "@/lib/channels-server";
import { getOrgContext } from "@/lib/orgs-server";
import { CreateOrganizationForm } from "@/components/org/CreateOrganizationForm";
import { SignOutButton } from "@/components/SignOutButton";
import { isSupabaseConfigured } from "@/lib/config";
import { ALL_CHANNELS, ALL_CHANNELS_SLUG, PATH_HEADER, channelSlug, unscopedScope } from "@/lib/channels";
import { NavigationProvider } from "@/components/navigation/NavigationProvider";
import { ScrollToTop } from "@/components/navigation/ScrollToTop";
import { createClient } from "@/lib/supabase/server";
import { readCreditAccount } from "@/lib/server/credits";
import type { CreditAccount } from "@/lib/credits";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const org = isSupabaseConfigured
    ? await getOrgContext()
    : { supported: false, orgs: [], current: null };

  // Signed in, organizations exist (0018 applied), and this account belongs to
  // none: a new sign-up. Nothing in the app would show them anything — RLS
  // returns no rows — so the whole screen is the one thing they can do: start
  // their own organization.
  if (org.supported && org.orgs.length === 0) {
    return (
      <div className="atmos relative flex min-h-dvh flex-col">
        <NeuralBackdrop dim />
        <div className="relative z-10 mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-4 p-4">
          <div className="flex justify-end">
            <SignOutButton />
          </div>
          <CreateOrganizationForm variant="first" />
        </div>
      </div>
    );
  }

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
  const path = (await headers()).get(PATH_HEADER);
  if (path) {
    const [, slug, ...rest] = path.split("/");
    if (slug && slug !== honest) redirect(["", honest, ...rest].join("/"));
  }

  // Credits in the header, for an organization that pays. The operator's own
  // (default) organization is exempt and shows none; so does a database
  // without migration 0020 — never a made-up zero.
  let credits: CreditAccount | null = null;
  if (org.supported && org.current && !org.current.is_default) {
    const supabase = await createClient();
    if (supabase) {
      const res = await readCreditAccount(supabase, org.current.id).catch(() => null);
      credits = res?.account ?? null;
    }
  }

  // The breadcrumb names a channel the way the switcher does, by its name — the
  // URL carries a slug, which is not always the name the operator gave it.
  const channelNames = Object.fromEntries(
    channels.map((c) => [channelSlug(c, channels), c.name || c.channel_id]),
  );

  return (
    <NavigationProvider channelNames={channelNames}>
      <div className="atmos relative flex min-h-dvh flex-col">
        <NeuralBackdrop dim />
        <div className="relative z-10 flex min-h-dvh flex-col">
          <Header
            channels={channels}
            selection={selection}
            orgs={org.orgs}
            currentOrgId={org.current?.id ?? null}
            credits={credits}
            scope={scope}
          />
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <SideNav />
            <main className="pad-page min-w-0 flex-1">{children}</main>
          </div>
        </div>
        <CommandPalette scope={scope} />
        <ScrollToTop />
      </div>
    </NavigationProvider>
  );
}
