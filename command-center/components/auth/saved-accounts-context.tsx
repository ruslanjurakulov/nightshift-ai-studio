"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Whether this browser keeps a parked account at all, as the sign-in page's server layout read it from its cookies
 * (lib/server/device-accounts.ts). Only then does the page ask for the list: everyone else's sign-in page makes no extra
 * request and draws exactly what it always did. Outside the provider (a test, another page) the answer is "no".
 */
const SavedAccountsContext = createContext(false);

export function SavedAccountsProvider({ present, children }: { present: boolean; children: ReactNode }) {
  return <SavedAccountsContext.Provider value={present}>{children}</SavedAccountsContext.Provider>;
}

export const useSavedAccountsPresent = () => useContext(SavedAccountsContext);
