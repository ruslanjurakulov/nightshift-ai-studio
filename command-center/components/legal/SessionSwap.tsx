"use client";

import { useEffect, useState } from "react";
import { hasSessionCookie } from "@/lib/session-hint";

/** True once the page is in the browser and a session cookie is there (lib/session-hint). False on the server and before. */
export function useSessionHint(): boolean {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    setSignedIn(hasSessionCookie(document.cookie));
  }, []);
  return signedIn;
}

/**
 * The public header's account keys, swapped for a signed-in visitor (audit 2026-11-21: a signed-in person on Pricing was offered
 * "Sign in" and "Start free"). The server renders `signedOut`, so the static pages stay static and a signed-out visitor's page
 * is byte-for-byte what it was; the browser swaps in `signedIn` after reading the cookie's name.
 */
export function SessionSwap({ signedOut, signedIn }: { signedOut: React.ReactNode; signedIn: React.ReactNode }) {
  return <>{useSessionHint() ? signedIn : signedOut}</>;
}
