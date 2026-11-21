import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { isOperator } from "@/lib/auth/org-roles";
import { ownerAccess } from "@/lib/server/owner-analytics";
import { OWNER_MODE_COOKIE, ownerFrame } from "@/lib/owner-mode";

/**
 * Which account the platform operator is LOOKING AS (the avatar menu's account switcher, lib/owner-mode.ts).
 *
 * `viewingAsOperator()` is what a customer page asks before it draws anything only an operator would see (hidden preview
 * models, the whole model registry, provider names, operator chrome). In the User account it is false for the owner too,
 * so the owner sees their workspace exactly as a customer does. It is a DRAWING decision only: who may read or write
 * anything is still the real role (isOperator, RLS, each route's own check), in either account.
 */
export const viewingAsOperator = cache(async (): Promise<boolean> => {
  const operator = await isOperator();
  if (!operator) return false;
  return ownerFrame(operator, (await cookies()).get(OWNER_MODE_COOKIE)?.value, await isPlatformOwner());
});

/**
 * Is this person the platform OWNER (not an admin)? The same database answer Owner Analytics trusts
 * (owner_analytics_is_owner(), migration 0182), asked once per request. Only "owner" is yes: a failed lookup, a missing
 * migration or a signed-out session are all no, so the Owner account is never offered on a guess.
 */
export const isPlatformOwner = cache(async (): Promise<boolean> => (await ownerAccess()) === "owner");
