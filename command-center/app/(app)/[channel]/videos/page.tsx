import { redirect } from "next/navigation";
import { getChannelPath } from "@/lib/channels-path-server";
import { redirectTarget } from "@/lib/studioRoutes";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Videos moved into Nightshift Studio: they are the Studio home's Videos shelf now
 * (docs/studio/STUDIO_IA.md §5). A server-side shim, not a next.config redirect, so the query is
 * carried over and the landing page can say where the screen went. redirect() answers 307 for one
 * release; it becomes permanent (308) once the canvas lands. The shelf reads exactly what this page
 * read, under the same RLS, so nothing about who may see a video changes.
 */
export default async function VideosMoved({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const path = await getChannelPath();
  redirect(path(redirectTarget("/videos", await searchParams, "videos")));
}
