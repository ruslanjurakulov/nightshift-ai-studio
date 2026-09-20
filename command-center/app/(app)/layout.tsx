import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { SideNav } from "@/components/SideNav";
import { NeuralBackdrop } from "@/components/NeuralBackdrop";
import { Header } from "@/components/Header";
import { CommandPalette } from "@/components/CommandPalette";
import { getChannelContext } from "@/lib/channels-server";
import { isSupabaseConfigured } from "@/lib/config";
import { ALL_CHANNELS, ALL_CHANNELS_SLUG, PATH_HEADER } from "@/lib/channels";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Channels for the switcher. Empty before the Phase 5 migration is applied,
  // in which case the switcher renders nothing and the app looks as it did.
  const { channels, selection, slug: honest } = isSupabaseConfigured
    ? await getChannelContext()
    : { channels: [], selection: ALL_CHANNELS, slug: ALL_CHANNELS_SLUG };

  // Keep the address bar honest, in both directions. A URL naming a channel
  // that does not exist (deleted, mistyped, or not visible to this user)
  // resolves to every channel, and says so. A URL naming the channel by its
  // internal id — /default/pipeline — resolves fine, and is rewritten to the
  // name the operator actually knows it by: /chronos/pipeline.
  const path = (await headers()).get(PATH_HEADER);
  if (path) {
    const [, slug, ...rest] = path.split("/");
    if (slug && slug !== honest) redirect(["", honest, ...rest].join("/"));
  }

  return (
    <div className="atmos relative flex min-h-dvh flex-col">
      <NeuralBackdrop dim />
      <div className="relative z-10 flex min-h-dvh flex-col">
        <Header channels={channels} selection={selection} />
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <SideNav />
          <main className="pad-page min-w-0 flex-1">{children}</main>
        </div>
      </div>
      <CommandPalette />
    </div>
  );
}
