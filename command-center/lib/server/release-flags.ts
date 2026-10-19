import "server-only";

/**
 * Is "publish when approved" (migration 0113) RELEASED to customers? Evaluated on the SERVER at request time, default OFF.
 *
 * The database half (the switch, the queue, the worker) can exist long before customers are told about it: the worker has its
 * own off switch, and the legal pages and the Google consent text still describe a product that never edits an existing video.
 * Until the owner sets `PUBLISH_ON_APPROVE_RELEASED=on` on the Command Center's server, NOTHING of the feature is shown:
 *
 *   - the Channels page has no "Publish when approved" switch (the channel's value is not even sent to the browser),
 *   - the video page's review panel says "Approve" everywhere, offers no "Approve and publish", and shows no request status.
 *
 * Deliberately NOT a `NEXT_PUBLIC_` variable: those are compiled into the browser bundle at build time, and a flag whose absence
 * (or a build that never saw it) could leave the feature visible is the failure this exists to prevent. Here an unset, empty or
 * unrecognised value is "off". The database functions stay callable; this hides the doors, it does not lock them.
 * How to release: docs/APPROVE_PUBLISH_1B.md ("Releasing it").
 */
export const PUBLISH_ON_APPROVE_FLAG = "PUBLISH_ON_APPROVE_RELEASED";

export function publishOnApproveReleased(env: Record<string, string | undefined> = process.env): boolean {
  return ["on", "1", "true", "yes"].includes(String(env[PUBLISH_ON_APPROVE_FLAG] ?? "").trim().toLowerCase());
}

/** A channel row as the page hands it to the browser when the feature is not released: without its switch. */
export function withoutPublishSwitch<T extends { publish_on_approve?: unknown }>(channel: T): T {
  const copy = { ...channel };
  delete copy.publish_on_approve;
  return copy;
}
