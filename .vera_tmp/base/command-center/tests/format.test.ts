import { describe, expect, it } from "vitest";
import { parseStoredTime, relativeTime, storedMs } from "@/lib/format";

/**
 * The bug these pin down.
 *
 * `event_log` writes `datetime.utcnow().isoformat()` — UTC with no `Z`. JS reads
 * a bare string like that as LOCAL time, so in a UTC+5 browser a poll that had
 * just finished rendered as "5h ago". Nothing was wrong in the database; only
 * the reading of it, and only away from UTC — which is why it survived every
 * previous check, all of which ran in UTC.
 */
describe("parseStoredTime", () => {
  const NAIVE_UTC = "2026-09-05T05:45:57.928000";

  it("reads a naive timestamp as UTC, not as the viewer's local time", () => {
    expect(parseStoredTime(NAIVE_UTC)?.toISOString()).toBe("2026-09-05T05:45:57.928Z");
  });

  it("agrees with the same instant written explicitly as UTC", () => {
    expect(storedMs(NAIVE_UTC)).toBe(storedMs(NAIVE_UTC + "Z"));
  });

  it("leaves an already-zoned timestamp exactly as it is", () => {
    // Postgres timestamptz comes back with an offset; appending Z would shift it.
    expect(parseStoredTime("2026-09-05T10:45:57+05:00")?.toISOString()).toBe(
      "2026-09-05T05:45:57.000Z",
    );
    expect(parseStoredTime("2026-09-05T05:45:57Z")?.toISOString()).toBe(
      "2026-09-05T05:45:57.000Z",
    );
  });

  it("leaves a date-only value alone (the spec already reads it as UTC)", () => {
    expect(parseStoredTime("2026-09-05")?.toISOString()).toBe("2026-09-05T00:00:00.000Z");
  });

  it("returns null rather than an Invalid Date", () => {
    for (const bad of [null, undefined, "", "   ", "not a date"]) {
      expect(parseStoredTime(bad)).toBeNull();
      expect(storedMs(bad)).toBeNull();
    }
  });
});

describe("relativeTime", () => {
  it("reports minutes for a recent event, not hours", () => {
    // The exact shape of the original report: a poll from 14 minutes ago that
    // rendered as "5h ago" for a UTC+5 viewer.
    const fourteenMinutesAgo = new Date(Date.now() - 14 * 60 * 1000)
      .toISOString()
      .replace("Z", "");
    expect(relativeTime(fourteenMinutesAgo)).toBe("14m ago");
  });

  it("still renders a zoned timestamp correctly", () => {
    const iso = new Date(Date.now() - 90 * 1000).toISOString();
    expect(relativeTime(iso)).toBe("2m ago");
  });

  it("returns the original string when it cannot be parsed", () => {
    expect(relativeTime("whenever")).toBe("whenever");
  });
});
