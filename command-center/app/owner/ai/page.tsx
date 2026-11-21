import { Suspense } from "react";
import { getDictionary } from "@/lib/i18n/server";
import { getUser } from "@/lib/supabase/server";
import { OwnerPage } from "@/components/owner-console/OwnerPage";
import { OwnerAssistant } from "@/components/owner-console/OwnerAssistant";
import { AiKpiSkeleton } from "@/components/owner-console/AiKpiCards";
import { fill } from "@/lib/owner-analytics/format";
import { firstNameOf } from "@/lib/owner-console/greeting";
import { mfaVerifyUrl } from "@/lib/security/admin-mfa";
import { requireOwnerConsole } from "@/lib/server/owner-console";
import { OwnerAiKpis } from "./_kpis";

export const dynamic = "force-dynamic";

/**
 * Owner Console — the owner's Nightshift AI. The owner check runs first (the layout's 404 is not a lock on a page). Above the chat,
 * four live cards drawn on the server from the figures the other owner pages already read (streamed in under a skeleton). The chat
 * panel itself holds no figure: the facts a question needs are built on the server per question (/api/brain/owner/turn), never
 * sent to the browser.
 */
export default async function OwnerConsoleAi() {
  await requireOwnerConsole();
  const { t, locale } = await getDictionary();
  const c = t.ownerConsole;
  const a = c.assistant;
  const name = firstNameOf((await getUser())?.user_metadata);
  const verifyHref = mfaVerifyUrl("/owner/ai");
  return (
    <OwnerPage title={name ? fill(a.greeting, { name }) : a.greetingNoName} subtitle={a.subtitle}>
      <Suspense fallback={<AiKpiSkeleton a={a} />}>
        <OwnerAiKpis c={c} locale={locale} verifyHref={verifyHref} />
      </Suspense>
      <OwnerAssistant a={a} verifyHref={verifyHref} signInHref={`/login?next=${encodeURIComponent("/owner/ai")}`} />
    </OwnerPage>
  );
}
