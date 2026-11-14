"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/config";
import { isGoogleEnabled } from "@/lib/google-signin";

/** undefined: nobody said (the button asks Supabase itself); boolean: the server's answer. */
const GoogleEnabledContext = createContext<boolean | undefined>(undefined);

export function GoogleEnabledProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <GoogleEnabledContext.Provider value={enabled}>{children}</GoogleEnabledContext.Provider>;
}

export const useGoogleEnabledFromServer = () => useContext(GoogleEnabledContext);

/**
 * Is "Continue with Google" offered on this page? The server's answer when there is one (there from the first paint,
 * no layout jump); without one the browser asks Supabase itself, once per page (isGoogleEnabled remembers it).
 *
 * One hook for the button and for the page around it: when Google is offered it is the page's primary key and the
 * e-mail submit steps down to the quiet key, so the two must never disagree about whether the button is there.
 */
export function useGoogleEnabled(): boolean {
  const fromServer = useGoogleEnabledFromServer();
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    if (fromServer !== undefined) return;
    let live = true;
    void isGoogleEnabled(SUPABASE_URL, SUPABASE_ANON_KEY).then((on) => {
      if (live) setAsked(on);
    });
    return () => {
      live = false;
    };
  }, [fromServer]);

  return fromServer ?? asked;
}
