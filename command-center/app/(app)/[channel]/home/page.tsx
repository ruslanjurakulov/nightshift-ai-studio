import { isSupabaseConfigured } from "@/lib/config";
import { NotConfigured } from "@/components/NotConfigured";
import { getOrgContext } from "@/lib/orgs-server";
import { loadEditorProjects } from "@/lib/server/editor";
import { HomeCreate, type HomeProjectsReading } from "@/components/customer/HomeCreate";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Home ("Nima yaratamiz?") — where a customer lands after sign-in (lib/navigation landingSection): the prompt box with
 * its Video | Image | Audio tabs, the top trend templates (stream S3's GET /api/templates, a designed placeholder until
 * it is deployed), what to continue, and for a new account three ways to start.
 *
 * Reads only the organization's editor projects, as the signed-in member (RLS); a missing table or a failed read says
 * so instead of an empty list that reads as "none yet". Nothing here writes, prices or starts anything: the box opens
 * Create with the words, and only Create's priced press spends. The channel's autopilot run stays on Create's YouTube
 * desk (/create?desk=youtube), and the channels themselves under the avatar menu.
 */
export default async function HomePage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const org = await getOrgContext();
  const orgId = org.supported && org.current ? org.current.id : null;
  let projects: HomeProjectsReading = { state: "not_available" };
  if (orgId) {
    const list = await loadEditorProjects(orgId);
    projects =
      list.state === "ok"
        ? { state: "ok", projects: list.value.map((p) => ({ id: p.id, title: p.title, updatedAt: p.updatedAt })) }
        : list.state === "not_available"
          ? { state: "not_available" }
          : { state: "failed" };
  }
  return <HomeCreate orgId={orgId} projects={projects} />;
}
