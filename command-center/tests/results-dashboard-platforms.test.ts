/**
 * The dashboard's platform registry agrees with the worker's publisher registry (modules/social_publish.py).
 * What would break without this: a platform that becomes connectable on the worker while the dashboard still says "coming"
 * (or the reverse: a card inviting a connection nothing can carry out), and a "results live" claim for a platform whose
 * results are not collected.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORMS, PLATFORM_IDS } from "../lib/resultsDashboard/platforms";

const SOURCE = readFileSync(join(__dirname, "..", "..", "modules", "social_publish.py"), "utf8");

function registeredPublishers(): string[] {
  const out: string[] = [];
  for (const chunk of SOURCE.split(/\nclass /).slice(1)) {
    const name = chunk.split(/[(:]/)[0];
    if (!name.endsWith("Publisher") || name.startsWith("_")) continue;
    const m = chunk.match(/^\s+platform = "([a-z]+)"/m);
    if (m && m[1]) out.push(m[1]);
  }
  return out.sort();
}

describe("platform registry vs the worker's publishers", () => {
  it("finds the worker's publishers (the scan is not vacuous)", () => {
    expect(registeredPublishers()).toEqual(["instagram", "tiktok", "youtube"]);
    expect(SOURCE).toMatch(/publishers\.register\(InstagramPublisher\.platform/);
  });
  it("marks exactly the registered publishers as connectable", () => {
    const connectable = PLATFORMS.filter((p) => p.publish === "available").map((p) => p.id).sort();
    expect(connectable).toEqual(registeredPublishers());
  });
  it("has results live only for YouTube, the one platform whose analytics the daily poll collects", () => {
    expect(PLATFORMS.filter((p) => p.results === "live").map((p) => p.id)).toEqual(["youtube"]);
    // A platform that cannot be connected cannot have results.
    for (const p of PLATFORMS) if (p.publish === "none") expect(p.results).toBe("planned");
  });
  it("lists each platform once, and the five the owner named", () => {
    expect(new Set(PLATFORM_IDS).size).toBe(PLATFORM_IDS.length);
    expect([...PLATFORM_IDS].sort()).toEqual(["facebook", "instagram", "tiktok", "x", "youtube"]);
    expect(PLATFORMS.map((p) => p.id)).toEqual([...PLATFORM_IDS]);
  });
});
