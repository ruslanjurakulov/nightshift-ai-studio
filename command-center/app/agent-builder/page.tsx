import type { Metadata } from "next";
import { AgentBuilder } from "@/components/agent-builder/AgentBuilder";

export const metadata: Metadata = {
  title: "Agent Node Builder — Nightshift Preview",
  description: "Design and validate creative workflows without running providers.",
  robots: { index: false, follow: false },
};
export default function AgentBuilderPage() {
  return <AgentBuilder />;
}
