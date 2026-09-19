import { atLeast, type Role } from "@/lib/auth/roles-shared";

/**
 * Pure eligibility helpers for two-person publish approval.
 *
 * These mirror the RLS policies in migration 0009 so the UI can hide controls
 * the database would reject — but the database, not this file, is the real
 * guard. Kept free of any server-only or React import so both the client board
 * and unit tests can use them.
 */

/** The status of a single approval request. */
export type ApprovalStatus = "pending" | "approved" | "rejected";

/**
 * Whether `myId` may approve or reject a request opened by `requesterId`.
 *
 * Two conditions, both from the update policy in 0009:
 *   1. the decider is an admin or above, and
 *   2. the decider is NOT the requester (the two-person rule).
 *
 * A request with no known requester (`requesterId` null) can never be decided —
 * the SQL `decided_by <> requested_by` is NULL, i.e. not true — so this returns
 * false there too.
 */
export function canDecide(role: Role, requesterId: string | null, myId: string): boolean {
  if (!atLeast(role, "admin")) return false;
  if (!requesterId) return false;
  return requesterId !== myId;
}

/** Whether `role` may open a publish-approval request (editor and up). */
export function canRequest(role: Role): boolean {
  return atLeast(role, "editor");
}

/** Whether `role` may flip a channel's two-person-publish flag (editor and up). */
export function canToggleRequirement(role: Role): boolean {
  return atLeast(role, "editor");
}
