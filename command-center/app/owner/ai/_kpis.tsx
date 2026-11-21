import "server-only";
import { readMoney } from "@/lib/server/owner-analytics";
import { aiKpis, tashkentDayStart, type MoneyRead } from "@/lib/owner-console/ai-kpis";
import type { OwnerConsoleDictionary } from "@/lib/i18n/owner-console/en";
import { AiKpiCards, AiKpiUnavailable } from "@/components/owner-console/AiKpiCards";
import { loadOwnerFacts } from "../_facts";

const DAY = 86_400_000;

/**
 * The live cards' reads, streamed in under a skeleton so the chat is usable while they load. The owner's facts are the same build
 * the Overview, Health and Providers pages draw from; today's revenue is Owner Analytics' own money read for today's window.
 */
export async function OwnerAiKpis({ c, locale, verifyHref, nowMs = Date.now() }: { c: OwnerConsoleDictionary; locale: string; verifyHref: string; nowMs?: number }) {
  const load = await loadOwnerFacts();
  if (!load.ok) return <AiKpiUnavailable kind={load.kind} a={c.assistant} f={c.facts} verifyHref={verifyHref} />;
  // Only after the facts loaded: that build asked the database for the second factor (admin_aal_ok) first, and 0182's money read
  // has no second-factor check of its own — read before it, a password-only session would see today's revenue.
  const money: MoneyRead = await readMoney(tashkentDayStart(nowMs), new Date(nowMs + DAY).toISOString());
  return <AiKpiCards kpis={aiKpis(load.facts, money, nowMs)} asOf={load.facts.as_of} a={c.assistant} f={c.facts} locale={locale} />;
}
