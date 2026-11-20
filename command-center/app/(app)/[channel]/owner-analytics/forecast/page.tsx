import { HubFrame, HubState, hubContext } from "@/components/owner-analytics/HubFrame";
import { Forecast } from "@/components/owner-analytics/Forecast";
import { readCostEntries, readPeople, readSpend } from "@/lib/server/owner-analytics";
import { readMoneyFor } from "@/lib/server/owner-analytics-data";
import { baseline } from "@/lib/owner-analytics/forecast";
import { applyScope, mrrAt } from "@/lib/owner-analytics/money";
import { tashkentDay, tashkentDayStartUtc } from "@/lib/owner-analytics/period";
import "../owner-analytics.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const DAY = 86_400_000;

/**
 * Owner analytics — forecast. The baseline is measured (the last 90 days of signups, conversion, churn, revenue and cost per
 * payer, and the owner's entered costs); the scenario is the owner's, moved with sliders in the browser. Measured MRR is drawn
 * solid; every projected figure is dashed or badged "projection". Costs (0183) are optional: without them their sliders start
 * as assumptions. Owner-only; read-only.
 */
export default async function OwnerAnalyticsForecast({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { access, ctx } = await hubContext(await searchParams);
  if (access !== "owner") return <HubState state={access} ctx={ctx} />;
  const { sel, now } = ctx;
  const inc = sel.includeInternal;

  const today = tashkentDay(now);
  const to = tashkentDayStartUtc(new Date(Date.parse(`${today}T00:00:00Z`) + DAY).toISOString().slice(0, 10));
  const from90 = new Date(Date.parse(to) - 90 * DAY).toISOString();
  const [peopleRead, money, spend, costs] = await Promise.all([
    readPeople(),
    readMoneyFor(sel),
    readSpend(from90, to),
    readCostEntries(`${new Date(Date.parse(to) - 120 * DAY).toISOString().slice(0, 7)}-01`, `${today.slice(0, 7)}-01`),
  ]);
  if (!peopleRead.ok) return <HubState state={peopleRead.reason} ctx={ctx} />;
  if (!money.ok) return <HubState state={money.reason} ctx={ctx} />;

  const people = applyScope(peopleRead.data, inc);
  const sales = applyScope(money.data, inc);
  const base = baseline(people, sales, now, spend.ok ? applyScope(spend.data, inc) : null, costs.ok ? costs.data : null);

  // Measured MRR at the end of each of the last twelve Tashkent months (and today).
  const history: Array<{ x: string; y: number | null }> = [];
  const [y, m] = today.split("-").map(Number);
  for (let k = 11; k >= 1; k--) {
    const firstOfNext = new Date(Date.UTC(y, m - k, 1)).toISOString().slice(0, 10);
    const label = new Date(Date.UTC(y, m - k - 1, 1)).toISOString().slice(0, 7);
    history.push({ x: label, y: mrrAt(sales, new Date(Date.parse(tashkentDayStartUtc(firstOfNext)) - 1).toISOString()).usd });
  }
  history.push({ x: today.slice(0, 7), y: mrrAt(sales, now.toISOString()).usd });

  return (
    <HubFrame ctx={ctx} section="forecast">
      <Forecast baseline={base} history={history} />
    </HubFrame>
  );
}
