import { getDictionary } from "@/lib/i18n/server";
import { OwnerPage, OwnerTools } from "@/components/owner-console/OwnerPage";
import { ownerSection } from "@/lib/owner-console/nav";
import { requireOwnerConsole } from "@/lib/server/owner-console";

export const dynamic = "force-dynamic";

/** Owner Console — Users & plans. It checks the platform owner itself first (the layout's 404 is not a lock on a page). S8 fills this page; until then it lists the owner tools that hold its data. */
export default async function OwnerConsoleUsers() {
  await requireOwnerConsole();
  const { t } = await getDictionary();
  const c = t.ownerConsole;
  return (
    <OwnerPage title={c.sections.users.title} subtitle={c.sections.users.subtitle}>
      <OwnerTools section={ownerSection("users")} c={c} />
    </OwnerPage>
  );
}
