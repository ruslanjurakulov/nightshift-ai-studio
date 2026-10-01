import { describe, expect, it } from "vitest";
import { dictionaries } from "@/lib/i18n";
import {
  NOTIFICATION_KINDS,
  ageParts,
  badgeText,
  describeNotification,
  numberField,
  parseInbox,
  type InboxRow,
} from "@/lib/notifications";

const ID = "11111111-2222-4333-8444-555555555555";
const row = (over: Partial<InboxRow>): InboxRow => ({
  id: "n1",
  org_id: "o1",
  kind: "credits_low",
  ref: "x",
  data: {},
  created_at: "2026-10-01T10:00:00Z",
  read_at: null,
  ...over,
});

describe("badgeText", () => {
  it("shows nothing at zero or for a non-number, a count up to nine, then 9+", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(-3)).toBeNull();
    expect(badgeText(Number.NaN)).toBeNull();
    expect(badgeText(1)).toBe("1");
    expect(badgeText(9)).toBe("9");
    expect(badgeText(10)).toBe("9+");
    expect(badgeText(400)).toBe("9+");
  });
});

describe("parseInbox", () => {
  it("keeps what the database sent and drops what this build cannot show", () => {
    const good = { id: "a", org_id: "o", kind: "storyboard_ready", ref: "r", data: { scenes: 3 }, created_at: "2026-10-01T10:00:00Z", read_at: null };
    const rows = parseInbox([
      good,
      { ...good, id: "b", kind: "from_the_future" },
      { ...good, id: "c", created_at: undefined },
      null,
      "x",
      { ...good, id: "d", data: [1], read_at: "2026-10-01T11:00:00Z" },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["a", "d"]);
    expect(rows[1]).toMatchObject({ data: {}, read_at: "2026-10-01T11:00:00Z" });
    expect(parseInbox(null)).toEqual([]);
    expect(parseInbox({})).toEqual([]);
  });
});

describe("numberField", () => {
  it("reads a number or a numeric string and nothing else (unknown is never 0)", () => {
    expect(numberField({ n: 6 }, "n")).toBe(6);
    expect(numberField({ n: "6.5" }, "n")).toBe(6.5);
    expect(numberField({}, "n")).toBeNull();
    expect(numberField({ n: null }, "n")).toBeNull();
    expect(numberField({ n: "" }, "n")).toBeNull();
    expect(numberField({ n: "abc" }, "n")).toBeNull();
  });
});

describe("describeNotification", () => {
  it("says credits were returned only when the row carries the number", () => {
    const withN = describeNotification(row({ kind: "creative_job_failed", data: { credits_returned: 6 } }));
    expect(withN).toMatchObject({ copy: "creativeFailed", amount: { key: "returned", n: 6 }, section: "/studio" });
    const without = describeNotification(row({ kind: "creative_job_failed", data: {} }));
    expect(without.amount).toBeNull();
    // A returned amount of 0 is a number the database sent, and is shown.
    expect(describeNotification(row({ kind: "creative_job_failed", data: { credits_returned: 0 } })).amount).toEqual({ key: "returned", n: 0 });
  });

  it("leads each kind to the screen where the person decides", () => {
    expect(describeNotification(row({ kind: "creative_job_completed", data: { credits_charged: 4 } }))).toMatchObject({
      copy: "creativeDone",
      amount: { key: "charged", n: 4 },
      section: "/library",
    });
    expect(describeNotification(row({ kind: "storyboard_ready", data: { storyboard_id: ID } })).section).toBe(`/videos/storyboard/${ID}`);
    expect(describeNotification(row({ kind: "creative_job_completed", data: { capability: "t2i", credits_charged: 4 } })).section).toBe("/library");
    expect(describeNotification(row({ kind: "editor_export_done", data: { project_id: ID } })).section).toBe(`/editor/${ID}`);
    expect(describeNotification(row({ kind: "credits_low", data: { available: 7 } }))).toMatchObject({
      copy: "creditsLow",
      amount: { key: "available", n: 7 },
      section: "/credits",
    });
  });

  it("never puts anything but a uuid into a link", () => {
    expect(describeNotification(row({ kind: "storyboard_ready", data: { storyboard_id: "../../admin" } })).section).toBe("/videos");
    expect(describeNotification(row({ kind: "editor_export_done", data: { project_id: "x?y=1" } })).section).toBe("/library");
    expect(describeNotification(row({ kind: "storyboard_ready", data: {} })).section).toBe("/videos");
  });

  it("marks read and unread", () => {
    expect(describeNotification(row({ read_at: null })).unread).toBe(true);
    expect(describeNotification(row({ read_at: "2026-10-01T11:00:00Z" })).unread).toBe(false);
  });
});

describe("ageParts", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  it("buckets into now / minutes / hours / days", () => {
    expect(ageParts("2026-10-01T11:59:40Z", now)).toEqual({ unit: "now", n: 0 });
    expect(ageParts("2026-10-01T11:55:00Z", now)).toEqual({ unit: "m", n: 5 });
    expect(ageParts("2026-10-01T09:00:00Z", now)).toEqual({ unit: "h", n: 3 });
    expect(ageParts("2026-09-28T12:00:00Z", now)).toEqual({ unit: "d", n: 3 });
    expect(ageParts("not a date", now)).toEqual({ unit: "now", n: 0 });
    expect(ageParts("2026-10-01T13:00:00Z", now)).toEqual({ unit: "now", n: 0 });
  });
});

// Every kind the database can write has words in every language, and the
// words never name a provider or a role.
describe("notification copy", () => {
  const COPY = ["creativeDone", "creativeFailed", "storyboardReady", "exportDone", "creditsLow"] as const;
  const BANNED = /openai|google|runway|kling|veo|sora|elevenlabs|replicate|fal\.ai|minimax|\b(owner|editor|viewer|admin)\b|владелец|редактор|наблюдатель|администратор|egasi|muharrir|kuzatuvchi/i;

  it("has a title and a body for each kind in en, ru and uz", () => {
    for (const [locale, d] of Object.entries(dictionaries)) {
      for (const c of COPY) {
        expect(d.notifications[c].title, `${locale}.${c}.title`).toMatch(/\S/);
        expect(d.notifications[c].body, `${locale}.${c}.body`).toMatch(/\S/);
      }
      for (const k of ["charged", "returned", "available"] as const) expect(d.notifications[k], `${locale}.${k}`).toContain("{n}");
    }
  });

  it("covers every database kind with a copy entry", () => {
    const used = new Set(NOTIFICATION_KINDS.map((k) => describeNotification(row({ kind: k })).copy));
    expect([...used].sort()).toEqual([...COPY].sort());
  });

  it("names no provider, model or role, and ru/uz are really translated", () => {
    const en = dictionaries.en.notifications;
    for (const [locale, d] of Object.entries(dictionaries)) {
      const strings = JSON.stringify(d.notifications);
      expect(strings, locale).not.toMatch(BANNED);
      if (locale === "en") continue;
      for (const c of COPY) expect(d.notifications[c].title, `${locale}.${c}`).not.toBe(en[c].title);
      expect(d.notifications.markAll).not.toBe(en.markAll);
    }
  });
});

describe("where a finished captions or describe job leads (nothing of theirs is in the Library)", () => {
  it("captions lead to the editor, finished or failed: the panel there has the transcript, the retry and the cancel", () => {
    for (const kind of ["creative_job_completed", "creative_job_failed"] as const) {
      expect(describeNotification(row({ kind, data: { capability: "captions", credits_charged: 4 } })).section).toBe("/editor");
    }
  });

  it("a description leads to the Studio's results, where its text is", () => {
    for (const kind of ["creative_job_completed", "creative_job_failed"] as const) {
      expect(describeNotification(row({ kind, data: { capability: "describe" } })).section).toBe("/create");
    }
  });

  it("every other capability keeps its old destination", () => {
    for (const capability of ["t2i", "t2v", "tts", "voice_change", "dub", "video_upscale", undefined, 5]) {
      expect(describeNotification(row({ kind: "creative_job_completed", data: { capability } })).section).toBe("/library");
      expect(describeNotification(row({ kind: "creative_job_failed", data: { capability } })).section).toBe("/studio");
    }
  });
});
