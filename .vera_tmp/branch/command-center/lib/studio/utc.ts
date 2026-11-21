/**
 * system_events.ts is text, often a naive utcnow().isoformat(): read without an offset it would be local time (Lens M1). One reader
 * for every place the live view parses an event time.
 */
export const utcIso = (ts: string): string => (/([zZ]|[+-]\d\d:?\d\d)$/.test(ts) ? ts : `${ts}Z`);
export const utc = (ts: string): Date => new Date(utcIso(ts));
