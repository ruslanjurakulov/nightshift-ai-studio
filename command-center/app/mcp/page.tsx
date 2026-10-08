import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { getDevDictionary } from "@/lib/i18n/dev";
import { chatCopy } from "@/components/landing/HeroCard";
import { HeroBleed } from "@/components/landing/HeroBleed";
import { PublicShell } from "@/components/legal/PublicShell";
import { McpPage } from "@/components/docs/McpPage";
import { docsOrigin } from "@/lib/api/docs-origin";
import { devPagesEnabled } from "@/lib/dev-pages";
import { mcpOauthLive } from "@/lib/mcp-oauth";
import { devPageMetadata } from "@/lib/dev/page-metadata";

// The origin in every snippet, the tab in the address and the two flags are read per request.
export const dynamic = "force-dynamic";

export function generateMetadata(): Promise<Metadata> {
  // One canonical address for every tab: the title and card do not change with ?tab=. While the sign-in is off the
  // description does not offer Claude or ChatGPT as something that connects today.
  const live = mcpOauthLive();
  return devPageMetadata("/mcp", (dev) => ({ title: dev.mcp.meta.title, description: live ? dev.mcp.meta.description : dev.mcp.signinOff.description }));
}

/**
 * Public: how to connect an AI assistant to the MCP server at /api/mcp
 * (lib/public-paths.ts INFO_PATHS). The open tab comes from `?tab=` on the
 * server, so a shared link opens on the right tab with no flash.
 */
export default async function McpConnectPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { t, locale } = await getDictionary();
  const { tab } = await searchParams;
  const dev = getDevDictionary(locale);
  return (
    <PublicShell t={t} current="docs">
      <McpPage
        dev={dev}
        bleed={<HeroBleed t={t} slot="mcp.hero" className="nx-mcp-bleed" />}
        chat={chatCopy(t, "hero", dev.mcp.land.asks.items[0].prompt, { badge: t.site.stage.tag, note: dev.mcp.land.frames.exampleNote })}
        pause={t.site.fx.pause}
        origin={docsOrigin()}
        labels={{ table: t.common.scrollTable, code: t.common.scrollCode }}
        showCli={devPagesEnabled()}
        oauthLive={mcpOauthLive()}
        initialTab={typeof tab === "string" ? tab : undefined}
      />
    </PublicShell>
  );
}
