import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/config";
import { createClient, getUser } from "@/lib/supabase/server";
import { getOrgContext } from "@/lib/orgs-server";
import { isPlatformAdmin } from "@/lib/auth/org-roles";
import { NotConfigured } from "@/components/NotConfigured";
import { WelcomeFlow } from "@/components/welcome/WelcomeFlow";
import { LEGAL } from "@/lib/legal";
import "../(app)/app-redesign.css";
import "../(app)/app-pages-g5.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * First run, for an account that has just signed up.
 *
 * Outside the channel layout on purpose: that layout resolves a channel and an
 * organization, and a brand-new account has neither — which is exactly the
 * state this page exists to get them out of. The (app) layout sends anyone
 * with no organization here, so a new account never sees an empty dashboard.
 *
 * Everything shown is read, not assumed: the channel count, the welcome grant
 * (the actual ledger row from migration 0027, or nothing), and whether this
 * account may connect YouTube itself.
 */
export default async function WelcomePage() {
  if (!isSupabaseConfigured) return <NotConfigured />;
  const user = await getUser();
  if (!user) redirect("/login");

  const org = await getOrgContext();
  const supabase = await createClient();

  let hasChannel = false;
  let welcomeCredits: number | null = null;
  if (supabase && (org.current || !org.supported)) {
    let channels = supabase.from("channels").select("channel_id", { count: "exact", head: true });
    if (org.current) channels = channels.eq("org_id", org.current.id);
    const [ch, grant] = await Promise.all([
      channels,
      org.current
        ? supabase
            .from("credit_transactions")
            .select("amount")
            .eq("org_id", org.current.id)
            .eq("external_id", `welcome:${user.id}`)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    hasChannel = (ch.count ?? 0) > 0;
    const amount = Number((grant.data as { amount?: unknown } | null)?.amount);
    welcomeCredits = Number.isFinite(amount) && amount > 0 ? amount : null;
  }

  return (
    <main className="g5-welcome">
        <WelcomeFlow
          needsWorkspace={org.supported && org.orgs.length === 0}
          unavailable={Boolean(org.unavailable)}
          hasChannel={hasChannel}
          // Connecting YouTube is restricted to the platform operator for now
          // (the Google OAuth app is limited to accounts it lists); anyone else
          // is told so and offered a request instead of a button that fails.
          canConnectYouTube={await isPlatformAdmin()}
          // The operator's own organization never pays; before 0018 there are
          // no customer organizations at all.
          showCredits={Boolean(org.supported && org.current && !org.current.is_default) || (org.supported && !org.current)}
          welcomeCredits={welcomeCredits}
          contactEmail={LEGAL.contactEmail}
        />
    </main>
  );
}
