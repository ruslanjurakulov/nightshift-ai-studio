import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary } from "@/lib/i18n/server";
import { getDevDictionary } from "@/lib/i18n/dev";
import { PublicShell } from "@/components/legal/PublicShell";
import { CliPage } from "@/components/docs/ToolPages";
import { devPagesEnabled } from "@/lib/dev-pages";
import { devPageMetadata } from "@/lib/dev/page-metadata";

// The flag is read per request (lib/dev-pages.ts): a page built once must not freeze it.
export const dynamic = "force-dynamic";

export function generateMetadata(): Promise<Metadata> {
  return devPageMetadata("/docs/cli", (dev) => dev.cli.meta);
}

/** Public only while DEV_CLI_PAGE=1. The middleware already answers the 404
 *  when it is off; this checks again, so a request that reached the page by
 *  any other route is still a 404. */
export default async function CliDocsPage() {
  if (!devPagesEnabled()) notFound();
  const { t, locale } = await getDictionary();
  return (
    <PublicShell t={t} current="docs">
      <CliPage dev={getDevDictionary(locale)} labels={{ table: t.common.scrollTable, code: t.common.scrollCode }} />
    </PublicShell>
  );
}
