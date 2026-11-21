import { redirect } from "next/navigation";
import { getChannelPath } from "@/lib/channels-path-server";
import { redirectTarget } from "@/lib/studioRoutes";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The editor's project list moved into Nightshift Studio: it is the Studio home's Projects shelf
 * now (docs/studio/STUDIO_IA.md §5, `?shelf=projects&kind=edit`). A project itself still opens at
 * /editor/{id}. A server-side shim (307 for one release), so the query is carried over. The shelf
 * reads what this page read, as the signed-in user under RLS.
 */
export default async function EditorMoved({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const path = await getChannelPath();
  redirect(path(redirectTarget("/editor", await searchParams, "editor")));
}
