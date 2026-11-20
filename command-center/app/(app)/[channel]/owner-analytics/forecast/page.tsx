import { HubFrame, HubState, hubContext } from "@/components/owner-analytics/HubFrame";
import { Forecast } from "@/components/owner-analytics/Forecast";
import { readCostEntries, readMoney, readPeople, readSpend } from "@/lib/server/owner-analytics";
import { HISTORY_FROM } from "@/lib/owner-analytics/kpis";
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
 *
 * The forecast always runs from today, whatever period the picker shows: money is read up to tomorrow (Tashkent), not to the
 * selected period's end — a past period would otherwise cut off every renewal after it and read as churn.
 */
export default async function OwnerAnalyticsForecast({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { access, ctx } = await hubContext(await searchParams);
  if (access !== "owner") return <HubState state={access} ctx={ctx} />;
  const { sel, now, d } = ctx;
  const inc = sel.includeInternal;

  const today = tashkentDay(now);
  const to = tashkentDayStartUtc(new Date(Date.parse(`${today}T00:00:00Z`) + DAY).toISOString().slice(0, 10));
  const from90 = new Date(Date.parse(to) - 90 * DAY).toISOString();
  const [peopleRead, money, spend, costs] = await Promise.all([
    readPeople(),
    readMoney(HISTORY_FROM, to),
    readSpend(from90, to),
    readCostEntries(`${new Date(Date.parse(to) - 120 * DAY).toISOString().slice(0, 7)}-01`, `${today.slice(0, 7)}-01`),
  ]);
  if (!peopleRead.ok) return <HubState state={peopleRead.reason} ctx={ctx} />;
  if (!money.ok) return <HubState state={money.reason} ctx={ctx} />;

  const people = applyScope(peopleRead.data, inc);
  const sales = applyScope(money.data, inc);
  // A cut spend read understates cost per payer: it is then not offered as measured.
  const spendRows = spend.ok && !spend.truncated ? applyScope(spend.data, inc) : null;
  const base = baseline(people, sales, now, spendRows, costs.ok ? costs.data : null);
  const notes: string[] = [d.forecastFromToday];
  if (money.truncated || peopleRead.truncated || (spend.ok && spend.truncated)) notes.push(d.truncated);
  if (!spend.ok || !costs.ok) {
    const missing = (!spend.ok && spend.reason === "missing") || (!costs.ok && costs.reason === "missing");
    notes.push(missing ? d.costsNotEnabled : d.costsReadFailed);
  }

  // Measured MRR at the end of each of the last twelve Tashkent months (and today). A month whose MRR is incomplete (an
  // amount missing, another currency, a refund of unknown size) is left as a gap rather than drawn as a measurement.
  const history: Array<{ x: string; y: number | null }> = [];
  let gaps = 0;
  const point = (at: string) => {
    const m = mrrAt(sales, at);
    if (m.incomplete) gaps++;
    return m.incomplete ? null : m.usd;
  };
  const [y, m] = today.split("-").map(Number);
  for (let k = 11; k >= 1; k--) {
    const firstOfNext = new Date(Date.UTC(y, m - k, 1)).toISOString().slice(0, 10);
    const label = new Date(Date.UTC(y, m - k - 1, 1)).toISOString().slice(0, 7);
    history.push({ x: label, y: point(new Date(Date.parse(tashkentDayStartUtc(firstOfNext)) - 1).toISOString()) });
  }
  history.push({ x: today.slice(0, 7), y: point(now.toISOString()) });
  if (gaps > 0) notes.push(d.mrrIncompleteGap);

  return (
    <HubFrame ctx={ctx} section="forecast">
      {notes.map((n) => (
        <p key={n} className="oa-note" data-tone={n === d.forecastFromToday ? undefined : "warn"}>
          {n}
        </p>
      ))}
      <Forecast baseline={base} history={history} />
    </HubFrame>
  );
}
