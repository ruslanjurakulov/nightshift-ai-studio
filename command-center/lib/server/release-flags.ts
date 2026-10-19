import "server-only";

/**
 * Is "publish when approved" (migration 0113) RELEASED to customers? Evaluated on the SERVER at request time, default OFF.
 *
 * The database half (the switch, the queue, the worker) can exist long before customers are told about it: the worker has its
 * own off switch, and the legal pages and the Google consent text still describe a product that never edits an existing video.
 * Until the owner sets `PUBLISH_ON_APPROVE_RELEASED=on` on the Command Center's server, the ENTRY POINTS are hidden, never the
 * truth about a channel that already has the switch on (that would say "Approve" over a button that publishes, and leave an
 * administrator no way to turn it off):
 *
 *   - Channels page: no "Publish when approved" switch (so no typed-word flow to turn it on); a channel whose switch is ON still
 *     shows it, and it can only be turned OFF;
 *   - video page: the key says "Approve and publish" and the request's state is shown only when the channel's database switch is
 *     ON; with it off the panel says "Approve" everywhere and shows nothing about the feature.
 *
 * (The channel rows reach the browser with the switch's value either way; a member may read it anyway. What the flag hides is
 * the control and the copy, not the value.)
 *
 * Deliberately NOT a `NEXT_PUBLIC_` variable: those are compiled into the browser bundle at build time, and a flag whose absence
 * (or a build that never saw it) could leave the feature visible is the failure this exists to prevent. Here an unset, empty or
 * unrecognised value is "off". The database functions stay callable; this hides the doors, it does not lock them.
 * How to release: docs/APPROVE_PUBLISH_1B.md ("Releasing it").
 */
export const PUBLISH_ON_APPROVE_FLAG = "PUBLISH_ON_APPROVE_RELEASED";

export function publishOnApproveReleased(raw: string | undefined = process.env.PUBLISH_ON_APPROVE_RELEASED): boolean {
  return ["on", "1", "true", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}

/**
 * A channel row as the Channels page hands it to the card. Released: as it is. Not released: with the switch's value only when it
 * is ON (the card draws it then, and can only turn it off); an off switch is dropped so the card has nothing to turn on.
 */
export function publishSwitchForCard<T extends { publish_on_approve?: unknown }>(channel: T, released: boolean): T {
  if (released || channel.publish_on_approve === true) return channel;
  const copy = { ...channel };
  delete copy.publish_on_approve;
  return copy;
}
