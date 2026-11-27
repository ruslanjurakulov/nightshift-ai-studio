import { getDictionary } from "@/lib/i18n/server";
import { getUser } from "@/lib/supabase/server";
import { OwnerAssistant } from "@/components/owner-console/OwnerAssistant";
import { fill } from "@/lib/owner-analytics/format";
import { firstNameOf } from "@/lib/owner-console/greeting";
import { mfaVerifyUrl } from "@/lib/security/admin-mfa";
import { requireOwnerConsole } from "@/lib/server/owner-console";
import { CHAT_MODELS, chatModelConfigured, type ChatModelId } from "@/lib/server/brain/llm";

export const dynamic = "force-dynamic";

/**
 * Owner Console — the owner's Nightshift AI: the chat and nothing else. The owner check runs first (the layout's 404 is not a lock
 * on a page). The page holds no figure: the live cards live on the Overview (/owner), and the facts a question needs are built on
 * the server per question (/api/brain/owner/turn), never sent to the browser.
 */
export default async function OwnerConsoleAi() {
  await requireOwnerConsole();
  const { t, locale } = await getDictionary();
  const a = t.ownerConsole.assistant;
  const name = firstNameOf((await getUser())?.user_metadata);
  return (
    <div className="oc-ai-page">
      <OwnerAssistant
        a={a}
        configuredModels={Object.fromEntries(
          (Object.keys(CHAT_MODELS) as ChatModelId[]).map((id) => [id, chatModelConfigured(id)]),
        )}
        greeting={name ? fill(a.greeting, { name }) : a.greetingNoName}
        verifyHref={mfaVerifyUrl("/owner/ai")}
        signInHref={`/login?next=${encodeURIComponent("/owner/ai")}`}
        // Only after requireOwnerConsole(): the history panel is drawn for the owner alone (its route 404s anyone else too).
        history
        locale={locale}
      />
    </div>
  );
}
