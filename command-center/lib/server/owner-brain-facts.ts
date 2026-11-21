import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { ownerAccess, readMoney } from "@/lib/server/owner-analytics";
import { readRunway } from "@/lib/server/owner-runway";
import { HISTORY_FROM } from "@/lib/owner-analytics/kpis";
import { churn, mrrAt, summarize, type Amount } from "@/lib/owner-analytics/money";
import { providerRunways } from "@/lib/owner-analytics/runway";
import { paymentPlan, PLAN_DAYS, type PaymentPlan } from "@/lib/owner-analytics/payment-plan";

/**
 * The owner's facts for Nightshift Brain: one compact JSON object about the whole system, built on the server for the platform
 * owner and no one else. It is what the owner's Nightshift AI is given as data, and what the Owner Console's pages read.
 *
 * WHO. buildOwnerFacts() throws OwnerOnlyError unless ownerAccess() says "owner"; the database refuses everyone else too
 * (0182's gate, 0196's functions, 0107's second factor). Nothing in a customer path may import this module — a test reads the
 * import graph and fails the build if one does (tests/owner-brain-isolation.test.ts).
 *
 * WHAT. Every figure is tagged: `measured` (read from a record of what happened), `estimated` (arithmetic on measurements, e.g.
 * top-ups minus spend) or `unknown` with the reason. Revenue is net of refunds and disputes but before provider fees, which no
 * webhook stores. Vendor costs and balances are in here: this object is owner-role output only.
 */

export class OwnerOnlyError extends Error {
  constructor(readonly access: string) {
    super("owner facts are for the platform owner only");
  }
}

export type Fact<T> = { state: "measured" | "estimated"; value: T; as_of: string } | { state: "unknown"; why: string };

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

function amount(a: Amount, asOf: string): Fact<number> {
  // A sale with no amount makes the figure a floor: said, never rounded into a total.
  return a.unknownCount > 0 ? { state: "unknown", why: `${a.unknownCount} payment(s) had no amount` } : { state: "measured", value: r2(a.usd), as_of: asOf };
}

async function rpcJson(name: "owner_brain_people" | "owner_brain_health"): Promise<Fact<Record<string, unknown>>> {
  const supabase = await createClient();
  if (!supabase) return { state: "unknown", why: "database not configured" };
  const { data, error } = await supabase.rpc(name);
  if (error) {
    const code = (error as { code?: string }).code;
    return {
      state: "unknown",
      why: code === "42883" || code === "PGRST202" ? "migration 0196 is not applied" : code === "NS401" ? "second factor required" : "read failed",
    };
  }
  if (!data || typeof data !== "object") return { state: "unknown", why: "empty answer" };
  const doc = data as Record<string, unknown>;
  return { state: "measured", value: doc, as_of: typeof doc.as_of === "string" ? doc.as_of : new Date().toISOString() };
}

export interface OwnerFacts {
  version: 1;
  as_of: string;
  people: Fact<Record<string, unknown>>;
  health: Fact<Record<string, unknown>>;
  revenue: Fact<{
    net_before_fees_7d: Fact<number>;
    net_before_fees_30d: Fact<number>;
    sales_30d: number;
    refunds_30d: number;
    disputes_30d: number;
    paying_workspaces_30d: number;
    mrr: Fact<number>;
    monthly_churn_30d: Fact<number>;
    other_currency_payments_30d: number;
    note: string;
  }>;
  providers: Fact<{
    plan: PaymentPlan;
    providers: Array<{
      id: string;
      name: string;
      status: string;
      left: Fact<number>;
      unit: string;
      per_day_14d: Fact<number>;
      runs_out_on: string | null;
      top_up_url: string | null;
    }>;
  }>;
}

/** The owner's facts. Throws OwnerOnlyError for anyone but the platform owner — before anything is read. */
export const buildOwnerFacts = cache(async (nowMs: number = Date.now()): Promise<OwnerFacts> => {
  const access = await ownerAccess();
  if (access !== "owner") throw new OwnerOnlyError(access);
  const asOf = new Date(nowMs).toISOString();
  const tomorrow = new Date(nowMs + DAY).toISOString();

  const [people, health, money, runway] = await Promise.all([
    rpcJson("owner_brain_people"),
    rpcJson("owner_brain_health"),
    readMoney(HISTORY_FROM, tomorrow),
    readRunway(nowMs),
  ]);

  let revenue: OwnerFacts["revenue"];
  if (!money.ok) revenue = { state: "unknown", why: money.reason === "missing" ? "migration 0182 is not applied" : "read failed" };
  else {
    const rows = money.data; // internal and demo workspaces stay excluded (they carry internal: true)
    const window = (days: number) => ({ from: new Date(nowMs - days * DAY).toISOString(), to: asOf });
    const s7 = summarize(rows, window(7));
    const s30 = summarize(rows, window(30));
    const m = mrrAt(rows, asOf);
    const c = churn(rows, window(30));
    revenue = {
      state: "measured",
      as_of: asOf,
      value: {
        net_before_fees_7d: amount(s7.netBeforeFees, asOf),
        net_before_fees_30d: amount(s30.netBeforeFees, asOf),
        sales_30d: s30.sales,
        refunds_30d: s30.refundCount,
        disputes_30d: s30.disputeCount,
        paying_workspaces_30d: s30.payingOrgs,
        mrr: m.usd === null ? { state: "unknown", why: "no subscription yet" } : m.incomplete ? { state: "unknown", why: "a subscription payment had no amount, another currency or a refund of unknown size" } : { state: "measured", value: r2(m.usd), as_of: asOf },
        monthly_churn_30d: c.rate === null ? { state: "unknown", why: `fewer than 5 subscribers at the start of the window (${c.base})` } : { state: "measured", value: r2(c.rate), as_of: asOf },
        other_currency_payments_30d: s30.otherCurrency.reduce((n, o) => n + o.count, 0),
        note: `USD, net of refunds and disputes, before provider fees (not stored). Internal and demo workspaces excluded.${money.truncated ? " The read was cut: figures may be understated." : ""}`,
      },
    };
  }

  let providers: OwnerFacts["providers"];
  if (!runway) providers = { state: "unknown", why: "database not configured" };
  else {
    const rows = providerRunways(runway);
    const plan = paymentPlan(rows, nowMs, PLAN_DAYS);
    providers = {
      state: "estimated",
      as_of: asOf,
      value: {
        plan,
        providers: rows.map((r) => {
          const line = [...plan.due, ...plan.unknown, ...plan.fine].find((l) => l.provider === r.id);
          return {
            id: r.id,
            name: r.name,
            status: r.status,
            left:
              r.left === null
                ? { state: "unknown", why: "no reading and no top-up, or spend not fully known" }
                : { state: r.ledger.remaining.kind === "reported" ? "measured" : "estimated", value: r2(r.left), as_of: r.checkedAt ?? asOf },
            unit: line?.unit ?? "usd",
            per_day_14d: r.perDay14d === null ? { state: "unknown", why: "spend over 14 days not fully known" } : { state: "measured", value: r2(r.perDay14d), as_of: asOf },
            runs_out_on: typeof line?.runsOutOn === "string" ? line.runsOutOn : null,
            top_up_url: line?.topUpUrl ?? null,
          };
        }),
      },
    };
  }

  return { version: 1, as_of: asOf, people, health, revenue, providers };
});
