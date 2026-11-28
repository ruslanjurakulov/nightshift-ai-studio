import type { Metadata } from "next";
import { AgentBuilder, type ProviderPreviews } from "@/components/agent-builder/AgentBuilder";
import { planProviderSelection } from "@/lib/agent-providers";
import { guardOperatorPage } from "@/lib/auth/org-roles";
import { getDictionary } from "@/lib/i18n/server";

export const metadata: Metadata = {
  title: "Agent Node Builder — Nightshift Preview",
  description: "Design and validate creative workflows without running providers.",
  robots: { index: false, follow: false },
};
// The guard reads the session and the operator lookup on every request; a cached render would serve one person's answer to the next.
export const dynamic = "force-dynamic";

/**
 * Operators only until launch (owner decision, 28 Nov). The middleware only asks for a session, so before this any signed-in customer
 * could open the builder. The page asks for itself, with the same guard as the other operator-only pages (Providers): a customer
 * gets the app's public 404, exactly as for a URL that does not exist, and none of the builder is rendered. A layout would not do
 * it: a layout's redirect does not stop the page beside it from running (BR-H-001).
 */
export default async function AgentBuilderPage() {
  await guardOperatorPage();
  // Each provider's review card, with the capability the builder has always previewed it for. Planned here, after the guard: the
  // registry behind it is server-only, and a plan carries the blockers only, never the registry's licensing or pricing state.
  const providerPreviews: ProviderPreviews = {
    ideogram: planProviderSelection({ provider: "ideogram", capability: "vector" }),
    byteplus: planProviderSelection({ provider: "byteplus", capability: "video" }),
  };
  // The canvas's words, in the visitor's language. Handed over as a prop: this page sits outside the app's I18nProvider, and the
  // full dictionaries must not reach a page's client bundle (scripts/public-bundle-check.mjs).
  const { t } = await getDictionary();
  return <AgentBuilder providerPreviews={providerPreviews} copy={t.agentBuilder} />;
}
