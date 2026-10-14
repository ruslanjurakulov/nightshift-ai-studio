"use client";

import { createContext, useContext, type ReactNode } from "react";

/** undefined: nobody said (the button asks Supabase itself); boolean: the server's answer. */
const GoogleEnabledContext = createContext<boolean | undefined>(undefined);

export function GoogleEnabledProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  return <GoogleEnabledContext.Provider value={enabled}>{children}</GoogleEnabledContext.Provider>;
}

export const useGoogleEnabledFromServer = () => useContext(GoogleEnabledContext);
