import type { Metadata } from "next";
import { AgentBuilder, type ProviderPreviews } from "@/components/agent-builder/AgentBuilder";
import { planProviderSelection } from "@/lib/agent-providers";

export const metadata: Metadata = {
  title: "Agent Node Builder — Nightshift Preview",
  description: "Design and validate creative workflows without running providers.",
  robots: { index: false, follow: false },
};
export default function AgentBuilderPage() {
  // Each provider's review card, with the capability the builder has always previewed it for. Planned here: the registry
  // behind it is server-only, and a plan carries the blockers only, never the registry's licensing or pricing state.
  const providerPreviews: ProviderPreviews = {
    ideogram: planProviderSelection({ provider: "ideogram", capability: "vector" }),
    byteplus: planProviderSelection({ provider: "byteplus", capability: "video" }),
  };
  return <AgentBuilder providerPreviews={providerPreviews} />;
}
