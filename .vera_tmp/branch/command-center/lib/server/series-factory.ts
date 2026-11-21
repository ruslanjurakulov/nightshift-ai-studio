import "server-only";

/**
 * Is the Series Factory (docs/SERIES_FACTORY.md, slice S3) switched on for customers? Evaluated on the SERVER at request time,
 * default OFF.
 *
 *  - OFF (unset, empty, or anything but on / 1 / true / yes): the plan page `/{channel}/series/{id}` answers the public 404 and makes
 *    NO database call; the "Plan a series" form and the recent-plans list on `/{channel}/series` are not rendered and not read. Nothing
 *    new is visible and nothing new is asked of the database.
 *  - ON: the page and the form exist. The form calls `request_series_plan`, which the database refuses ("permission denied") until the
 *    owner grants it to signed-in users; that refusal is shown as "not available yet", so switching this on before the grant breaks
 *    nothing and charges nothing. The worker that makes the plans has its own switch (NIGHTSHIFT_SERIES_PLANNER on the worker).
 *
 * Deliberately NOT a `NEXT_PUBLIC_` variable: those are compiled into the browser bundle at build time, and a flag whose absence could
 * leave the feature visible is the failure this exists to prevent. This hides the doors; it does not lock the database functions
 * (the grant does that).
 */
export const SERIES_FACTORY_FLAG = "SERIES_FACTORY_ENABLED";

export function seriesFactoryEnabled(raw: string | undefined = process.env.SERIES_FACTORY_ENABLED): boolean {
  return ["on", "1", "true", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}
