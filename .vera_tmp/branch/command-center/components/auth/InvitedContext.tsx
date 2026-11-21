"use client";

import { createContext, useContext } from "react";

/**
 * Whether this visitor came through a live invite link (the httpOnly cookie
 * /i/<token> sets, read by the sign-up layout on the server). The page only
 * learns "yes" or "no": the token itself never reaches the browser's script.
 */
const InvitedContext = createContext(false);

export function InvitedProvider({ invited, children }: { invited: boolean; children: React.ReactNode }) {
  return <InvitedContext.Provider value={invited}>{children}</InvitedContext.Provider>;
}

export function useInvited(): boolean {
  return useContext(InvitedContext);
}
