"use client";

import { ErrorScreen } from "@/components/feedback/ErrorScreen";
import { HOME } from "@/components/SectionShell";
import { useChannelPath } from "@/lib/channels-client";

/**
 * A section that throws keeps the header and side nav: the operator can go
 * anywhere else in the app instead of facing a blank tab.
 */
export default function SectionError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const path = useChannelPath();
  return <ErrorScreen error={error} reset={reset} homeHref={path(HOME)} />;
}
