import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { isCreditExempt } from "@/lib/credits";
import { readCreditAccount } from "@/lib/server/credits";
import { readConnectedAccounts } from "@/lib/connectedAccounts";
import { isSocialConfigured } from "@/lib/server/social-oauth";
import { accountPlan, creditsSpent, type AccountPlan, type AccountSummary } from "@/lib/account";
import { readBillingSummary } from "@/lib/server/plans";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** PostgREST returns at most this many rows a request on Supabase's default. */
const PAGE = 1000;
/** Enough for any real account; past it "spent" reads as unknown, not short. */
const MAX_PAGES = 20;

/**
 * The account panel's data, read on open.
 *
 * Read-only, and read as the signed-in user (anon key + their session, so RLS
 * decides): the email from their session, the plan and credits from their
 * organization's plan (0034) and ledger (0020), the connected accounts from their channels.
 * Nothing here writes, spends or publishes, and nothing secret is returned or
 * logged.
 */
export async function GET() {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const supabase = await createClient();
  if (!supabase) return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const org = await getOrgContext();
  const current = org.supported ? org.current : null;

  let plan: AccountPlan = { kind: "unknown" };
  let credits: AccountSummary["credits"] = null;

  if (current && (current.is_default || isCreditExempt(current.id))) {
    plan = { kind: "exempt" };
  } else if (current) {
    // The plan is the organization's real subscription state (0034's
    // billing_summary), not a guess from its purchases.
    const [account, summary, spent] = await Promise.all([
      readCreditAccount(supabase, current.id).catch(() => null),
      readBillingSummary(supabase, current.id).catch(() => null),
      readSpent(supabase, current.id),
    ]);
    plan = accountPlan(summary, false);
    const acc = account?.account;
    credits = acc
      ? {
          available: acc.available,
          reserved: acc.reserved,
          spent,
          fromPlan: summary ? summary.credits.subscription : null,
          fromTopups: summary ? summary.credits.pack : null,
        }
      : null;
  }

  const accounts = await readConnectedAccounts().catch(() => []);
  const connectable = { instagram: isSocialConfigured("instagram"), tiktok: isSocialConfigured("tiktok") };
  const body: AccountSummary = { email: user.email ?? null, plan, credits, accounts, connectable };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

/** Sum of the organization's capture rows, paged; null when unreadable. */
async function readSpent(
  supabase: NonNullable<Awaited<ReturnType<typeof createClient>>>,
  orgId: string,
): Promise<number | null> {
  const rows: { amount: number | string | null; kind?: string; job_id?: string | null }[] = [];
  let total: number | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error, count } = await supabase
      .from("credit_transactions")
      .select("amount, kind, job_id", page === 0 ? { count: "exact" } : undefined)
      .eq("org_id", orgId)
      // Charges, net of refunded paid downloads (migration 0030).
      .or("kind.eq.capture,and(kind.eq.refund,job_id.like.download:*)")
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error || !data) return null;
    if (page === 0) total = count ?? null;
    rows.push(...(data as { amount: number | string | null; kind?: string; job_id?: string | null }[]));
    if (data.length < PAGE || (total !== null && rows.length >= total)) break;
  }
  return creditsSpent(rows, total);
}
