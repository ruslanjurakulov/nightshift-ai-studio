import { describe, expect, it } from "vitest";
import { OWNER_SECTIONS, OWNER_SECTION_KEYS, currentOwnerSection } from "@/lib/owner-console/nav";
import { RESERVED_ROOT_SEGMENTS } from "@/lib/public-paths";
import { isValidChannelId, isSection } from "@/lib/channels";
import { en } from "@/lib/i18n/en";
import { ru } from "@/lib/i18n/ru";
import { uz } from "@/lib/i18n/uz";

describe("the Owner Console's map", () => {
  it("has the seven sections, in order, under /owner", () => {
    expect(OWNER_SECTIONS.map((s) => s.key)).toEqual([...OWNER_SECTION_KEYS]);
    for (const s of OWNER_SECTIONS) expect(s.href === "/owner" || s.href.startsWith("/owner/"), s.href).toBe(true);
  });

  it("lights the deepest section for a path, and nothing outside the console", () => {
    expect(currentOwnerSection("/owner")).toBe("overview");
    expect(currentOwnerSection("/owner/")).toBe("overview");
    expect(currentOwnerSection("/owner/revenue")).toBe("revenue");
    expect(currentOwnerSection("/owner/revenue/2026?x=1")).toBe("revenue");
    expect(currentOwnerSection("/owners")).toBeNull();
    expect(currentOwnerSection("/chronos/margin")).toBeNull();
  });

  it("links only to sections that exist, so the middleware puts the channel in front of each", () => {
    for (const s of OWNER_SECTIONS) {
      for (const tool of s.tools) {
        const first = tool.href.split(/[/?]/)[1];
        expect(isSection(first), tool.href).toBe(true);
      }
    }
  });
});

describe("/owner can never be a channel", () => {
  it("is a reserved root segment, refused as a channel id", () => {
    expect(RESERVED_ROOT_SEGMENTS).toContain("owner");
    expect(isValidChannelId("owner")).toBe(false);
  });
});

describe("the console's words", () => {
  it("exist in all three languages, key for key", () => {
    const keys = (o: object): string[] =>
      Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? keys(v).map((x) => `${k}.${x}`) : [k])).sort();
    expect(keys(ru.ownerConsole)).toEqual(keys(en.ownerConsole));
    expect(keys(uz.ownerConsole)).toEqual(keys(en.ownerConsole));
  });
});
