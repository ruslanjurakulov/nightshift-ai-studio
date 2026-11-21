import "server-only";
import { notFound } from "next/navigation";
import { buildOwnerFacts, OwnerOnlyError, SecondFactorRequiredError, type OwnerFacts } from "@/lib/server/owner-brain-facts";

/**
 * The Owner Console pages' one read of the owner's facts. Lives inside the owner's zone (app/owner/), the only place outside
 * the facts module itself allowed to name it (tests/owner-brain-facts.test.ts). buildOwnerFacts() is React-cached, so the
 * pages and the layout share one build per request.
 *
 * A page has already passed requireOwnerConsole(); an OwnerOnlyError here would mean the two checks disagree, and the page
 * answers the 404 rather than drawing "failed" — never a frame around nothing.
 */
export type FactsLoad = { ok: true; facts: OwnerFacts } | { ok: false; kind: "second_factor" | "failed" };

export async function loadOwnerFacts(): Promise<FactsLoad> {
  try {
    return { ok: true, facts: await buildOwnerFacts() };
  } catch (e) {
    if (e instanceof OwnerOnlyError) notFound();
    if (e instanceof SecondFactorRequiredError) return { ok: false, kind: "second_factor" };
    // Logged by name only: the facts hold owner-only figures and an error object could carry part of one.
    console.error("owner console: facts failed", e instanceof Error ? e.name : "unknown");
    return { ok: false, kind: "failed" };
  }
}
