import { notFound, redirect } from "next/navigation";
import { getChannelPath } from "@/lib/channels-path-server";
import { redirectTarget } from "@/lib/studioRoutes";
import { filmStudioOpen } from "@/lib/server/films";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Studio → Projects moved onto the Studio home's Projects shelf (docs/studio/STUDIO_IA.md §5):
 * a server-side shim (307 for one release). The switch is still checked here first
 * (NIGHTSHIFT_FILM_STUDIO, default off): off, or `admins` for anyone but a platform admin, this is
 * a 404 exactly as before, so a redirect never tells anyone the section exists. A project itself
 * still opens at /create/projects/{id}.
 */
export default async function StudioProjectsMoved({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!(await filmStudioOpen())) notFound();
  const path = await getChannelPath();
  redirect(path(redirectTarget("/create/projects", (await searchParams) ?? {}, "projects")));
}
