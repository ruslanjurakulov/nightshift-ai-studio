"use server";

import { cookies } from "next/headers";
import { RECOVERY_COOKIE, recoveryCookieOptions } from "@/lib/recovery";

/**
 * The new password is saved; the recovery marker has done its job. It is an
 * httpOnly cookie, so the page cannot clear it itself. (A marker left behind is
 * harmless — it expires on its own after 15 minutes and only gates the page —
 * but a used one should not linger.) Next checks a server action's Origin.
 */
export async function finishRecovery(): Promise<void> {
  (await cookies()).set(RECOVERY_COOKIE, "", recoveryCookieOptions(0));
}
