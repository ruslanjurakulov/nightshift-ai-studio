import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESERVED_ROOT_SEGMENTS } from "@/lib/public-paths";
import { channelSlug, isUnknownRootPath, isValidChannelId, slugifyChannelId } from "@/lib/channels";
import type { ChannelRow } from "@/lib/types";

/**
 * BR-L-160: the whole /atelier path is the public 404 (lib/concepts.ts), so a
 * channel whose id, or whose name's URL slug, is "atelier" would lose every
 * screen. The word is reserved like `docs` and `privacy`.
 */

const row = (channel_id: string, name: string) => ({ channel_id, name }) as unknown as ChannelRow;

describe("atelier is a reserved root segment", () => {
  it("is in the reserved list", () => {
    expect(RESERVED_ROOT_SEGMENTS).toContain("atelier");
  });

  it("is refused as a channel id, in any form the id rule would otherwise accept", () => {
    expect(isValidChannelId("atelier")).toBe(false);
    // The other words around it are still fine.
    for (const ok of ["atelier-2", "my-atelier", "ateliers", "atelie"]) expect(isValidChannelId(ok)).toBe(true);
  });

  it("the Add channel wizard cannot create it: a name of Atelier derives an id the wizard refuses", () => {
    for (const name of ["Atelier", " ATELIER ", "atelier!"]) {
      expect(slugifyChannelId(name)).toBe("atelier");
      expect(isValidChannelId(slugifyChannelId(name))).toBe(false);
    }
    const src = readFileSync(join(__dirname, "..", "components/channels/AddChannelWizard.tsx"), "utf8");
    expect(src).toContain("const idValid = isValidChannelId(effectiveId);");
    expect(src).toMatch(/disabled=\{busy \|\| !idValid \|\|/);
  });

  it("a channel named Atelier keeps its id as its URL segment, never the reserved word", () => {
    const c = row("x1", "Atelier");
    expect(channelSlug(c, [c])).toBe("x1");
  });

  it("is not read as an unknown one-segment URL (it is a page of its own)", () => {
    expect(isUnknownRootPath("/atelier")).toBe(false);
  });
});
