import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { getDevDictionary } from "@/lib/i18n/dev";
import { PublicShell } from "@/components/legal/PublicShell";
import { McpPage } from "@/components/docs/McpPage";
import { docsOrigin } from "@/lib/api/docs-origin";
import { devPagesEnabled } from "@/lib/dev-pages";
import { mcpOauthLive } from "@/lib/mcp-oauth";
import { devPageMetadata } from "@/lib/dev/page-metadata";

// The origin in every snippet, the tab in the address and the two flags are read per request.
export const dynamic = "force-dynamic";

export function generateMetadata(): Promise<Metadata> {
  // One canonical address for every tab: the title and card do not change with ?tab=.
  return devPageMetadata("/mcp", (dev) => dev.mcp.meta);
}

/**
 * Public: how to connect an AI assistant to the MCP server at /api/mcp
 * (lib/public-paths.ts INFO_PATHS). The open tab comes from `?tab=` on the
 * server, so a shared link opens on the right tab with no flash.
 */
export default async function McpConnectPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { t, locale } = await getDictionary();
  const { tab } = await searchParams;
  return (
    <PublicShell t={t} current="docs">
      <McpPage
        dev={getDevDictionary(locale)}
        origin={docsOrigin()}
        labels={{ table: t.common.scrollTable, code: t.common.scrollCode }}
        showCli={devPagesEnabled()}
        oauthLive={mcpOauthLive()}
        initialTab={typeof tab === "string" ? tab : undefined}
      />
    </PublicShell>
  );
}
