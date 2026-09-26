import { NextResponse } from "next/server";
import { createClient, getUser } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { isCreditExempt } from "@/lib/credits";
import { readCreditAccount } from "@/lib/server/credits";
import { readConnectedAccounts } from "@/lib/connectedAccounts";
import { creditsSpent, derivePlan, type AccountSummary, type Plan } from "@/lib/account";

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
 * organization's ledger (0020), the connected accounts from their channels.
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

  let plan: Plan = { kind: "unknown" };
  let credits: AccountSummary["credits"] = null;

  if (current && (current.is_default || isCreditExempt(current.id))) {
    plan = { kind: "exempt" };
  } else if (current) {
    const [account, purchases, spent] = await Promise.all([
      readCreditAccount(supabase, current.id).catch(() => null),
      supabase
        .from("credit_transactions")
        .select("kind,amount,note,created_at")
        .eq("org_id", current.id)
        .eq("kind", "purchase")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1),
      readSpent(supabase, current.id),
    ]);
    plan = derivePlan(purchases.error ? null : purchases.data);
    const acc = account?.account;
    credits = acc ? { available: acc.available, reserved: acc.reserved, spent } : null;
  }

  const accounts = await readConnectedAccounts().catch(() => []);
  const body: AccountSummary = { email: user.email ?? null, plan, credits, accounts };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

/** Sum of the organization's capture rows, paged; null when unreadable. */
async function readSpent(
  supabase: NonNullable<Awaited<ReturnType<typeof createClient>>>,
  orgId: string,
): Promise<number | null> {
  const rows: { amount: number | string | null }[] = [];
  let total: number | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error, count } = await supabase
      .from("credit_transactions")
      .select("amount", page === 0 ? { count: "exact" } : undefined)
      .eq("org_id", orgId)
      .eq("kind", "capture")
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error || !data) return null;
    if (page === 0) total = count ?? null;
    rows.push(...(data as { amount: number | string | null }[]));
    if (data.length < PAGE || (total !== null && rows.length >= total)) break;
  }
  return creditsSpent(rows, total);
}
