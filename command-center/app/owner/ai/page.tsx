import { getDictionary } from "@/lib/i18n/server";
import { OwnerPage } from "@/components/owner-console/OwnerPage";
import { OwnerAssistant } from "@/components/owner-console/OwnerAssistant";
import { mfaVerifyUrl } from "@/lib/security/admin-mfa";
import { requireOwnerConsole } from "@/lib/server/owner-console";

export const dynamic = "force-dynamic";

/**
 * Owner Console — the owner's Nightshift AI. The owner check runs first (the layout's 404 is not a lock on a page). The page hands
 * the panel its words only: the facts are built on the server per question (/api/brain/owner/turn), never sent to the browser.
 */
export default async function OwnerConsoleAi() {
  await requireOwnerConsole();
  const { t } = await getDictionary();
  const c = t.ownerConsole;
  return (
    <OwnerPage title={c.sections.ai.title} subtitle={c.sections.ai.subtitle}>
      <OwnerAssistant a={c.assistant} verifyHref={mfaVerifyUrl("/owner/ai")} />
    </OwnerPage>
  );
}
