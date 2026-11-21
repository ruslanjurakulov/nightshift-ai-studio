import type { PaymentPlan } from "@/lib/owner-analytics/payment-plan";

/**
 * The shape of the owner's facts (the server-only facts builder makes them, for the owner only). Types only: the Owner Console's
 * components read this file, never the server module, so the import-graph test can forbid naming that module anywhere
 * outside the owner's zones.
 */
export type Fact<T> = { state: "measured" | "estimated"; value: T; as_of: string } | { state: "unknown"; why: string };

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
    /** The money read hit its row cap: every figure may be understated. */
    truncated: boolean;
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
