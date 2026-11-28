import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { dbRefusal } = await import("@/lib/server/brain/session");

/** 0232's chat_reserved as the routes answer it: the database's numbers and time, and null for any it could not give (rule 5). */
describe("dbRefusal: chat_reserved", () => {
  it("passes the held numbers and the time the hold ends", async () => {
    const res = dbRefusal({ code: "NS429", message: "chat_reserved", details: "used=12 reserved=18 limit=30 until=2026-11-27T14:05:00Z" })!;
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "chat_reserved", used: 12, reserved: 18, limit: 30, until: "2026-11-27T14:05:00Z" });
  });

  it("scope person: the person's own daily limit held by their own storyboard", async () => {
    const res = dbRefusal({ code: "NS429", message: "chat_reserved", details: "used=40 reserved=4 limit=44 until=2026-11-27T14:05:00Z scope=person" })!;
    expect(await res.json()).toEqual({ error: "chat_reserved", used: 40, reserved: 4, limit: 44, until: "2026-11-27T14:05:00Z", scope: "person" });
  });

  it("the Free trial has no limit, and a detail it cannot read gives nulls, never zeros", async () => {
    const trial = dbRefusal({ code: "NS429", message: "chat_reserved", details: "used=1 reserved=2 limit= until=" })!;
    expect(await trial.json()).toEqual({ error: "chat_reserved", used: 1, reserved: 2, limit: null, until: null });
    const garbled = dbRefusal({ code: "NS429", message: "chat_reserved", details: "nonsense" })!;
    expect(await garbled.json()).toEqual({ error: "chat_reserved", used: null, reserved: null, limit: null, until: null });
  });
});
