import { getDictionary } from "@/lib/i18n/server";
import { OwnerPage, OwnerTools } from "@/components/owner-console/OwnerPage";
import { ownerSection } from "@/lib/owner-console/nav";

export const dynamic = "force-dynamic";

/** Owner Console — System health. The layout has already confirmed the platform owner. S8 fills this page; until then it lists the owner tools that hold its data. */
export default async function OwnerConsoleHealth() {
  const { t } = await getDictionary();
  const c = t.ownerConsole;
  return (
    <OwnerPage title={c.sections.health.title} subtitle={c.sections.health.subtitle}>
      <OwnerTools section={ownerSection("health")} c={c} />
    </OwnerPage>
  );
}
