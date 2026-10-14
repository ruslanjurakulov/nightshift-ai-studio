import type { ReactNode } from "react";
import { googleEnabledOnServer } from "@/lib/server/google-enabled";
import { GoogleEnabledProvider } from "@/components/auth/google-enabled-context";

/** Server wrapper for /login and /signup: renders the pages knowing whether Google sign-in is on. */
export async function GoogleEnabled({ children }: { children: ReactNode }) {
  const enabled = await googleEnabledOnServer();
  return <GoogleEnabledProvider enabled={enabled}>{children}</GoogleEnabledProvider>;
}
