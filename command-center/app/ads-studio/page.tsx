import type { Metadata } from "next";
import { AdsStudioWorkspace } from "@/components/ads-studio/AdsStudioWorkspace";

export const metadata: Metadata = {
  title: "Ads Studio Preview | Nightshift",
  description: "Draft brand-consistent ad concepts for feed, stories and landscape placements.",
  robots: { index: false, follow: false },
};
export default function AdsStudioPage() {
  return <AdsStudioWorkspace />;
}
