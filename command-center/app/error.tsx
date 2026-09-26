"use client";

import { ErrorScreen } from "@/components/feedback/ErrorScreen";

/**
 * Catches what the channel-level boundary cannot: a failure in the app shell
 * itself (the org or channel lookup in (app)/layout) or on a public page. "/"
 * sends a signed-in visitor to their dashboard.
 */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="atmos flex min-h-dvh items-center justify-center">
      <ErrorScreen error={error} reset={reset} homeHref="/" />
    </div>
  );
}
