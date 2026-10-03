import type { Metadata } from "next";
import { getDictionary } from "@/lib/i18n/server";
import { getDevDictionary } from "@/lib/i18n/dev";
import { PublicShell } from "@/components/legal/PublicShell";
import { McpPage } from "@/components/docs/McpPage";
import { docsOrigin } from "@/lib/api/docs-origin";
import { devPagesEnabled } from "@/lib/dev-pages";
import { devPageMetadata } from "@/lib/dev/page-metadata";

// The origin in every snippet and the CLI/Skills flag are read per request.
export const dynamic = "force-dynamic";

export function generateMetadata(): Promise<Metadata> {
  return devPageMetadata("/mcp", (dev) => dev.mcp.meta);
}

/** Public: how to connect an AI assistant to the MCP server at /api/mcp (lib/public-paths.ts INFO_PATHS). */
export default async function McpConnectPage() {
  const { t, locale } = await getDictionary();
  return (
    <PublicShell t={t} current="docs">
      <McpPage
        dev={getDevDictionary(locale)}
        origin={docsOrigin()}
        labels={{ table: t.common.scrollTable, code: t.common.scrollCode }}
        showCli={devPagesEnabled()}
      />
    </PublicShell>
  );
}
