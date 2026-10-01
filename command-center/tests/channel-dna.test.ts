import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Channel DNA (migration 0056): what a channel's look and voice read as, what
 * each form starts from, what the route sends to the database, and the
 * migration's own pins. The security lab (tests/security/test_sec_channel_dna.py)
 * attacks the same rules against a live database.
 *
 * What would break without these: a pre-filled value that is not one the form
 * can show (a custom voice in a list that has no option for it), a retried
 * job's own settings overwritten by the channel's, a malformed body reaching
 * the database, a refusal turning into a 500 or a fake success, and a route
 * quietly reaching for the service key — which would skip every same-org check.
 */

vi.mock("server-only", () => ({}));

type Result = { data: unknown; error: { code?: string; message?: string } | null };
const KIT = "0b000000-0000-4000-8000-00000000000b";
const C = (n: number) => `0c000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ADAM = "pNInz6obpgDQGcFmaJgB"; // a premade voice in lib/voices.json
const CUSTOM = "ZzZzZzZzZzZzZzZzZzZz"; // a valid id the premade list does not have

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "me@example.com" } as { id: string; email: string } | null,
  rpc: { data: null, error: null } as Result,
  calls: [] as { name: string; args: unknown }[],
  audits: [] as unknown[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (name: string, args: unknown) => {
      h.calls.push({ name, args });
      return Promise.resolve(h.rpc);
    },
  }),
  getUser: async () => h.user,
}));
vi.mock("@/lib/server/audit", () => ({ logAudit: async (e: unknown) => void h.audits.push(e) }));

const {
  EMPTY_DNA,
  characterIdsByChannel,
  dnaAspect,
  dnaFromChannel,
  hasDna,
  languageCode,
  mapDnaError,
  parseDnaInput,
  runDna,
  studioDna,
  withChannelDna,
} = await import("@/lib/channel-dna");
const route = await import("../app/api/channels/dna/route");

const row = (over: Record<string, unknown> = {}) =>
  ({
    agent_config: { language: "Uzbek", elevenlabs_voice_id: ADAM, auto_publish: true },
    default_style_kit_id: KIT,
    dna_format: "shorts",
    dna_aspect: null,
    dna_tone: "calm, curious",
    ...over,
  }) as Parameters<typeof dnaFromChannel>[0];

beforeEach(() => {
  h.user = { id: "u1", email: "me@example.com" };
  h.rpc = { data: { channel_id: "chan-a" }, error: null };
  h.calls.length = 0;
  h.audits.length = 0;
});

describe("reading a channel's DNA", () => {
  it("reads the existing columns: the kit, the pipeline's voice and language", () => {
    const d = dnaFromChannel(row(), [C(1), C(2)]);
    expect(d).toEqual({
      styleKitId: KIT,
      characterIds: [C(1), C(2)],
      voiceId: ADAM,
      language: "uz",
      languageRaw: "Uzbek",
      format: "shorts",
      aspect: null,
      tone: "calm, curious",
    });
    expect(hasDna(d)).toBe(true);
  });

  it("a row from before 0056 is empty DNA, never a guess", () => {
    expect(dnaFromChannel(row({ agent_config: {}, default_style_kit_id: undefined, dna_format: undefined, dna_tone: undefined }))).toEqual(EMPTY_DNA);
    expect(dnaFromChannel(null)).toEqual(EMPTY_DNA);
    expect(hasDna(EMPTY_DNA)).toBe(false);
  });

  it("drops what the database would refuse", () => {
    const d = dnaFromChannel(
      row({ agent_config: { elevenlabs_voice_id: "12345", language: "Arabic" }, default_style_kit_id: "kit-1", dna_format: "vertical", dna_aspect: "4:3" }),
    );
    expect(d.voiceId).toBeNull();
    expect(d.styleKitId).toBeNull();
    expect(d.format).toBeNull();
    expect(d.aspect).toBeNull();
    // A language outside uz/ru/en is shown as stored, not mapped to one of them.
    expect(d.language).toBeNull();
    expect(d.languageRaw).toBe("Arabic");
  });

  it("maps the pipeline's language names both ways", () => {
    expect(languageCode("Russian")).toBe("ru");
    expect(languageCode(" english ")).toBe("en");
    expect(languageCode("Klingon")).toBeNull();
  });

  it("orders character rows by position, per channel", () => {
    const m = characterIdsByChannel([
      { channel_id: "a", character_id: C(2), position: 1 },
      { channel_id: "b", character_id: C(3), position: 0 },
      { channel_id: "a", character_id: C(1), position: 0 },
      { channel_id: "a", character_id: "../x", position: 2 },
    ]);
    expect(m.get("a")).toEqual([C(1), C(2)]);
    expect(m.get("b")).toEqual([C(3)]);
  });

  it("the format decides the aspect unless one was picked", () => {
    expect(dnaAspect({ ...EMPTY_DNA, format: "shorts" })).toBe("9:16");
    expect(dnaAspect({ ...EMPTY_DNA, format: "long" })).toBe("16:9");
    expect(dnaAspect({ ...EMPTY_DNA, format: "shorts", aspect: "1:1" })).toBe("1:1");
    expect(dnaAspect(EMPTY_DNA)).toBeNull();
  });
});

describe("what the forms start from", () => {
  it("the Studio starts in the channel's aspect and voice", () => {
    expect(studioDna(dnaFromChannel(row()))).toEqual({ aspect: "9:16", voiceId: ADAM });
    expect(studioDna(EMPTY_DNA)).toBeNull();
  });

  it("a custom voice never pre-fills a list that cannot show it", () => {
    const d = dnaFromChannel(row({ agent_config: { elevenlabs_voice_id: CUSTOM } }));
    expect(studioDna(d)?.voiceId).toBeNull();
    expect(runDna(d)?.voice ?? "").toBe("");
  });

  it("a link's placeholder aspect gives way to the channel's; its own voice and kind stay", () => {
    const tool = { capability: "t2i" as const, model: "", prompt: "", aspect: "16:9" as const, duration: 5 as const };
    expect(withChannelDna(tool, { aspect: "9:16", voiceId: ADAM })).toEqual({ ...tool, aspect: "9:16" });
    const speech = { ...tool, capability: "tts" as const };
    expect(withChannelDna(speech, { aspect: null, voiceId: ADAM })?.voiceId).toBe(ADAM);
    expect(withChannelDna(null, { aspect: "9:16", voiceId: null })).toBeNull();
    expect(withChannelDna(tool, null)).toBe(tool);
  });

  it("Run now starts in the channel's language and voice, and a Shorts channel at the shortest length", () => {
    expect(runDna(dnaFromChannel(row()))).toEqual({ language: "Uzbek", voice: ADAM, duration: "60" });
    expect(runDna(dnaFromChannel(row({ dna_format: "long" })))).toEqual({ language: "Uzbek", voice: ADAM, duration: "" });
    expect(runDna(EMPTY_DNA)).toBeNull();
  });
});

describe("parseDnaInput", () => {
  const ok = { channel_id: "chan-a", style_kit_id: KIT, character_ids: [C(1)], voice_id: ADAM, language: "uz", format: "long", aspect: "16:9", tone: " warm\u0007 " };

  it("cleans and keeps a valid body", () => {
    const p = parseDnaInput(ok);
    expect(p).toEqual({
      ok: true,
      value: { channelId: "chan-a", styleKitId: KIT, characterIds: [C(1)], voiceId: ADAM, language: "uz", format: "long", aspect: "16:9", tone: "warm" },
    });
  });

  it("empty values clear (kit, characters, format, aspect, tone) or leave as is (voice, language)", () => {
    const p = parseDnaInput({ channel_id: "chan-a", style_kit_id: null, character_ids: [], voice_id: "", language: null, tone: "" });
    expect(p.ok && p.value).toMatchObject({ styleKitId: null, characterIds: [], voiceId: null, language: null, format: null, aspect: null, tone: "" });
  });

  it.each([
    ["no body", null, "bad_request"],
    ["a bad channel", { ...ok, channel_id: "../x" }, "bad_request"],
    ["a bad kit", { ...ok, style_kit_id: "kit" }, "invalid_style_kit"],
    ["nine characters", { ...ok, character_ids: Array.from({ length: 9 }, (_, i) => C(i)) }, "too_many_characters"],
    ["a twice-picked character", { ...ok, character_ids: [C(1), C(1)] }, "duplicate_character"],
    ["a bad character", { ...ok, character_ids: ["hero"] }, "invalid_character"],
    ["a number for a voice", { ...ok, voice_id: "12345" }, "invalid_voice"],
    ["a language name", { ...ok, language: "Uzbek" }, "invalid_language"],
    ["a made-up format", { ...ok, format: "vertical" }, "invalid_format"],
    ["a made-up aspect", { ...ok, aspect: "4:3" }, "invalid_aspect"],
    ["a long tone", { ...ok, tone: "x".repeat(201) }, "invalid_tone"],
  ])("refuses %s", (_label, body, error) => {
    expect(parseDnaInput(body)).toEqual({ ok: false, error });
  });
});

describe("mapDnaError", () => {
  it("turns the database's refusals into words and statuses", () => {
    expect(mapDnaError({ code: "NS400", message: "invalid_character" })).toEqual({ error: "invalid_character", status: 400 });
    expect(mapDnaError({ code: "NS400", message: "something else" })).toEqual({ error: "bad_request", status: 400 });
    expect(mapDnaError({ code: "42501", message: "forbidden" })).toEqual({ error: "forbidden", status: 403 });
    expect(mapDnaError({ code: "P0002", message: "not_found" })).toEqual({ error: "not_found", status: 404 });
    expect(mapDnaError({ code: "PGRST202", message: "Could not find the function" })).toEqual({ error: "not_available", status: 503 });
    expect(mapDnaError({ code: "XX000", message: "boom" })).toEqual({ error: "failed", status: 502 });
  });
});

describe("POST /api/channels/dna", () => {
  const post = (body: unknown) =>
    route.POST(
      new Request("http://x/api/channels/dna", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  it("signed out: 401 and nothing touched", async () => {
    h.user = null;
    const res = await post({ channel_id: "chan-a" });
    expect(res.status).toBe(401);
    expect(h.calls).toEqual([]);
  });

  it("calls set_channel_dna once, as the user, with every argument in its place", async () => {
    const res = await post({ channel_id: "chan-a", style_kit_id: KIT, character_ids: [C(1)], voice_id: ADAM, language: "ru", format: "shorts", aspect: null, tone: "dry wit" });
    expect(res.status).toBe(200);
    expect(h.calls).toEqual([
      {
        name: "set_channel_dna",
        args: {
          p_channel_id: "chan-a",
          p_style_kit_id: KIT,
          p_character_ids: [C(1)],
          p_voice_id: ADAM,
          p_language: "ru",
          p_format: "shorts",
          p_aspect: null,
          p_tone: "dry wit",
        },
      },
    ]);
    // The audit says what changed, never the words of the tone.
    expect(JSON.stringify(h.audits)).not.toContain("dry wit");
    expect(h.audits).toEqual([
      {
        action: "channel.dna.update",
        channelId: "chan-a",
        detail: { style_kit: true, characters: 1, voice: true, language: "ru", format: "shorts", aspect: null, tone: true },
      },
    ]);
  });

  it("a malformed body never reaches the database", async () => {
    for (const body of ["{", { channel_id: "chan-a", character_ids: ["x"] }, { channel_id: "chan-a", tone: 5 }]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });

  it("another organization's kit is a 400 word, not a 500 or a success", async () => {
    h.rpc = { data: null, error: { code: "NS400", message: "invalid_style_kit" } };
    const res = await post({ channel_id: "chan-a", style_kit_id: KIT });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_style_kit" });
    expect(h.audits).toEqual([]);
  });

  it("a channel the caller cannot edit is refused as the database says", async () => {
    h.rpc = { data: null, error: { code: "42501", message: "forbidden" } };
    expect((await post({ channel_id: "chan-a" })).status).toBe(403);
    h.rpc = { data: null, error: { code: "P0002", message: "not_found" } };
    expect((await post({ channel_id: "chan-b" })).status).toBe(404);
  });

  it("never reaches for the service key, and never spends or publishes", () => {
    const src = readFileSync(join(__dirname, "..", "app/api/channels/dna/route.ts"), "utf8");
    expect(src).not.toMatch(/SERVICE_ROLE|service_role|serviceRole|createServiceClient|SUPABASE_SECRET/i);
    expect(src).not.toMatch(/dispatch|reserve_credits|create_creative_job|publish_requests|review_intents/);
  });
});

describe("migration 0056", () => {
  const SQL = readFileSync(join(__dirname, "..", "..", "supabase/migrations/0056_channel_dna.sql"), "utf8");
  const CODE = SQL.split("\n")
    .map((l) => l.split("--")[0])
    .join("\n");

  it("gives a browser select on the character rows, never a write", () => {
    expect(CODE).toContain("alter table public.channel_dna_characters enable row level security;");
    expect(CODE).toContain("revoke all on public.channel_dna_characters from public, anon, authenticated, service_role;");
    expect(CODE).toContain("grant select on public.channel_dna_characters to authenticated;");
    expect(CODE).not.toMatch(/grant [^;]*\b(insert|update|delete)\b[^;]* on public\.channel_dna_characters/);
  });

  it("pins a character to the channel's organization by key and by trigger", () => {
    expect(CODE).toMatch(/foreign key \(character_id, org_id\)\s+references public\.characters \(id, org_id\) on delete cascade/);
    expect(CODE).toMatch(/c\.channel_id = new\.channel_id and c\.org_id = new\.org_id/);
    expect(CODE).toMatch(/before insert or update on public\.channel_dna_characters/);
  });

  it("writes only for an editor of the channel's org, as a pinned security definer", () => {
    expect(CODE).toMatch(/set_channel_dna\([\s\S]*?\) returns jsonb\s+language plpgsql volatile security definer set search_path = public, pg_temp/);
    expect(CODE).toContain("public.is_org_member(ch.org_id, 'editor')");
    expect(CODE).toMatch(/grant execute on function public\.set_channel_dna\(text, uuid, uuid\[\], text, text, text, text, text\) to authenticated;/);
    expect(CODE).not.toMatch(/grant execute on function public\.set_channel_dna[^;]* to [^;]*\banon\b/);
  });

  it("merges into agent_config instead of replacing it", () => {
    expect(CODE).toMatch(/agent_config = coalesce\(agent_config, '\{\}'::jsonb\) \|\| patch/);
  });

  it("carries a Verify query", () => {
    expect(SQL).toMatch(/-- Verify/);
  });
});
