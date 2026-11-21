import { getDictionary } from "@/lib/i18n/server";
import { OwnerPage, OwnerTools } from "@/components/owner-console/OwnerPage";
import { ownerSection } from "@/lib/owner-console/nav";
import { requireOwnerConsole } from "@/lib/server/owner-console";

export const dynamic = "force-dynamic";

/** Owner Console — Overview. It checks the platform owner itself first (the layout's 404 is not a lock on a page). S8 fills this page; until then it lists the owner tools that hold its data. */
export default async function OwnerConsoleOverview() {
  await requireOwnerConsole();
  const { t } = await getDictionary();
  const c = t.ownerConsole;
  return (
    <OwnerPage title={c.sections.overview.title} subtitle={c.sections.overview.subtitle}>
      <OwnerTools section={ownerSection("overview")} c={c} />
    </OwnerPage>
  );
}
