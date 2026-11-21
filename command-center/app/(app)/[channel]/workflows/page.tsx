import { redirect } from "next/navigation";
import { getChannelPath } from "@/lib/channels-path-server";
import { studioRoute } from "@/lib/studioRoutes";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The saved-workflows list moved into Nightshift Studio (lib/studioRoutes ZOMBIE_SECTIONS): the audit (2026-11-21) found this
 * page drawing the old list under a "now lives in Nightshift Studio" line. middleware.ts answers the URL before anything
 * renders; this shim is the same move for a request that reaches the page anyway. A workflow and its runs still open at
 * /workflows/{id}, read as the signed-in user under RLS, exactly as before.
 */
export default async function WorkflowsMoved({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const path = await getChannelPath();
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) q.append(k, one);
  const s = q.toString();
  redirect(path(studioRoute(`/workflows${s ? `?${s}` : ""}`)?.href ?? "/studio"));
}
