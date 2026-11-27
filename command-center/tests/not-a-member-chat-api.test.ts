/**
 * Migration 0226, the owner's five (27 Nov): Nightshift AI's trial and daily cap, and the API's key and terms settings, refuse a
 * platform owner or admin who holds no seat with NS400 `not_a_member`.
 *
 * What would break: the chat route answering "unavailable" (a 503 the panel offers to retry, and a retry can never work), the
 * panel offering Retry, or a language without the sentence; the Developer console saying "could not save" for a refusal whose
 * remedy is a seat.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { readFileSync } from "node:fs";
import path from "node:path";
import { dbRefusal } from "@/lib/server/brain/session";
import { aiChatEn } from "@/lib/i18n/ai-chat/en";
import { aiChatRu } from "@/lib/i18n/ai-chat/ru";
import { aiChatUz } from "@/lib/i18n/ai-chat/uz";
import { dictionaries } from "@/lib/i18n";

describe("Nightshift AI", () => {
  it("the route answers not_a_member, 403, never the retryable unavailable", async () => {
    const res = dbRefusal({ code: "NS400", message: "not_a_member", details: "you are not a member" });
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "not_a_member" });
  });

  it("the panel says it in every language and offers no Retry", () => {
    const texts = [aiChatEn, aiChatRu, aiChatUz].map((d) => (d.errors as Record<string, string>).not_a_member);
    for (const t of texts) expect(t).toBeTruthy();
    expect(new Set(texts).size).toBe(3);
    expect(texts[2]).toContain("aʼzo");
    const panel = readFileSync(path.join(__dirname, "..", "components", "brain", "NightshiftAiPanel.tsx"), "utf8");
    const start = panel.indexOf("const NO_RETRY = [");
    expect(panel.slice(start, panel.indexOf("];", start))).toContain('"not_a_member"');
  });
});

describe("the Developer console", () => {
  it("names the seat for a refused key, limit or activation, in every language", () => {
    const texts = (["en", "ru", "uz"] as const).map((l) => findKey(dictionaries[l], "settingsNotAMember"));
    for (const t of texts) expect(t).toBeTruthy();
    expect(new Set(texts).size).toBe(3);
    const console_ = readFileSync(path.join(__dirname, "..", "components", "developers", "DeveloperConsole.tsx"), "utf8");
    expect(console_.match(/isNotAMember\(e\)/g)?.length).toBe(3); // key creation, the key's limit, the activation
  });
});

function findKey(node: unknown, key: string): string {
  if (!node || typeof node !== "object") return "";
  const o = node as Record<string, unknown>;
  if (typeof o[key] === "string") return o[key] as string;
  for (const v of Object.values(o)) {
    const hit = findKey(v, key);
    if (hit) return hit;
  }
  return "";
}
