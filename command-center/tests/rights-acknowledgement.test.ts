import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dictionaries } from "@/lib/i18n";
import { rightsAckEn } from "@/lib/i18n/rights-acknowledgement/en";
import { CREATIVE_ERRORS, mapCreativeError, type CreativeDb } from "@/lib/creative/operations";
import { acknowledgeRights, acknowledgementStatus, parseAcknowledgeInput } from "@/lib/creative/acknowledgements";
import {
  RIGHTS_KINDS,
  RIGHTS_SUBJECT_KEYS,
  RIGHTS_TERMS_HREF,
  RIGHTS_TEXT_VERSIONS,
  acknowledgeProblem,
  inputSubjects,
  nextGroup,
  parseRefusalDetail,
  parseStatus,
  wordsFor,
} from "@/lib/rights-acknowledgement";

// The rights acknowledgement step (migration 0174). What would break, and which test says so: the words this build shows not
// being the version the database counts (a person would acknowledge words they never saw, or never be able to acknowledge);
// a kind or an input key the app and the database disagree on; a refusal read as "nothing to ask"; a sentence missing in a
// language; a malformed answer from the database read as success.

const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(join(ROOT, "supabase/migrations/0174_rights_acknowledgement.sql"), "utf8");
const DOC = readFileSync(join(ROOT, "docs/RIGHTS_ACKNOWLEDGEMENT.md"), "utf8");
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";

describe("the app and 0174 agree", () => {
  it("the text version of every kind is the one the migration seeds", () => {
    const seeded = Object.fromEntries([...SQL.matchAll(/\('([a-z_]+)', '([a-z_]+\.v\d+)'\)/g)].map((m) => [m[1], m[2]]));
    expect(seeded).toEqual(RIGHTS_TEXT_VERSIONS);
  });

  it("the kinds are the closed list the database checks, in its order", () => {
    const m = /rights_acknowledgement_kinds_kind_check\s+check \(kind in \(([^)]*)\)\)/.exec(SQL);
    expect(m).not.toBeNull();
    expect(m![1].split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual([...RIGHTS_KINDS]);
  });

  it("the inputs asked about are the ones rights_acknowledgement_missing reads", () => {
    const body = /function public\.rights_acknowledgement_missing\([\s\S]*?\$\$;/.exec(SQL)![0];
    expect([...body.matchAll(/p_params ->> '([a-z_]+)'/g)].map((m) => m[1])).toEqual([...RIGHTS_SUBJECT_KEYS]);
  });

  it("the refusal detail the database writes is the one the Studio reads", () => {
    expect(SQL).toContain("format('kind=%s version=%s subject=%s'");
    expect(parseRefusalDetail(`kind=likeness_photo version=likeness_photo.v1 subject=${A}`)).toEqual({
      kind: "likeness_photo",
      textVersion: "likeness_photo.v1",
      subject: A,
    });
    expect(parseRefusalDetail(`kind=likeness_foto version=none subject=${A}`)).toEqual({ kind: "likeness_foto", textVersion: null, subject: A });
    for (const bad of [null, 3, "", "kind=likeness_photo", `subject=${A} kind=x version=y`]) expect(parseRefusalDetail(bad)).toBeNull();
  });

  it("the link goes to the section of the Terms that holds §6.2", () => {
    expect(RIGHTS_TERMS_HREF).toBe("/terms#acceptable-use");
    const terms = readFileSync(join(__dirname, "..", "lib/legal-docs/en.ts"), "utf8");
    expect(terms).toMatch(/id: "acceptable-use"[\s\S]*?"6\.2\. Generated images, video and voice\./);
  });

  it("the doc maps every kind", () => {
    for (const k of RIGHTS_KINDS) expect(DOC).toContain(`\`${k}\``);
  });
});

describe("the words, in en, ru and uz", () => {
  it("every locale has the same keys and a non-empty sentence for each", () => {
    const keys = (o: unknown, p = ""): string[] =>
      typeof o === "object" && o !== null
        ? Object.entries(o).flatMap(([k, v]) => keys(v, `${p}${k}.`))
        : [p.slice(0, -1)];
    const want = keys(rightsAckEn).sort();
    for (const loc of ["en", "ru", "uz"] as const) {
      const d = dictionaries[loc].rightsAck;
      expect(keys(d).sort(), loc).toEqual(want);
      for (const k of want) {
        const v = k.split(".").reduce<unknown>((o, part) => (o as Record<string, unknown>)[part], d);
        expect(typeof v === "string" && v.trim().length > 0, `${loc}.${k}`).toBe(true);
      }
      for (const kind of RIGHTS_KINDS) {
        expect(d.kinds[kind].question.endsWith("?"), `${loc} ${kind}`).toBe(true);
      }
    }
  });

  it("Uzbek keeps the owner's plain, direct wording", () => {
    const uz = dictionaries.uz.rightsAck.kinds.likeness_photo;
    expect(uz.question).toBe("Bu odamning yuzidan foydalanish uchun javobgarlikni oʻz zimmangizga olasizmi?");
    expect(uz.statement).toMatch(/koʻringan har bir insonning .*roziligi borligini tasdiqlayman\.$/);
    // The codebase's Uzbek letters: oʻ / gʻ with U+02BB, never an ASCII apostrophe.
    for (const s of Object.values(dictionaries.uz.rightsAck.kinds).flatMap((k) => [k.question, k.statement])) expect(s).not.toMatch(/['`]/);
  });

  it("the refusal has a sentence in every locale", () => {
    expect(CREATIVE_ERRORS).toContain("acknowledgement_required");
    for (const loc of ["en", "ru", "uz"] as const) {
      expect((dictionaries[loc].creative.errors as Record<string, string>).acknowledgement_required, loc).toBeTruthy();
    }
  });
});

describe("reading the database", () => {
  it("inputSubjects: the two media inputs, each once, only uuids", () => {
    expect(inputSubjects({ source_asset_id: A, end_asset_id: B, prompt: "x" })).toEqual([
      { key: "source_asset_id", id: A },
      { key: "end_asset_id", id: B },
    ]);
    expect(inputSubjects({ source_asset_id: A, end_asset_id: A })).toEqual([{ key: "source_asset_id", id: A }]);
    expect(inputSubjects({ source_asset_id: "nope", style_kit_id: A })).toEqual([]);
  });

  it("parseStatus: a malformed answer is null, never 'nothing missing'", () => {
    expect(parseStatus({ required: [], missing: [] })).toEqual({ required: [], missing: [] });
    expect(
      parseStatus({
        required: [{ kind: "likeness_photo", text_version: "likeness_photo.v1" }],
        missing: [{ kind: "likeness_photo", text_version: "likeness_photo.v1", subject: A }],
      }),
    ).toEqual({
      required: [{ kind: "likeness_photo", textVersion: "likeness_photo.v1" }],
      missing: [{ kind: "likeness_photo", textVersion: "likeness_photo.v1", subject: A }],
    });
    for (const bad of [null, [], {}, { required: [] }, { required: [], missing: [{ kind: "x" }] }, { required: [1], missing: [] }]) {
      expect(parseStatus(bad)).toBeNull();
    }
  });

  it("wordsFor: only a known kind at the version this build carries is shown", () => {
    expect(wordsFor({ kind: "likeness_photo", textVersion: "likeness_photo.v1", subject: A })).toEqual({
      ok: true,
      kind: "likeness_photo",
      textVersion: "likeness_photo.v1",
    });
    for (const m of [
      { kind: "likeness_photo", textVersion: "likeness_photo.v2", subject: A },
      { kind: "likeness_photo", textVersion: null, subject: A },
      { kind: "likeness_foto", textVersion: "likeness_foto.v1", subject: A },
    ]) {
      expect(wordsFor(m)).toEqual({ ok: false, reason: "stale" });
    }
  });

  it("nextGroup: one kind at a time, with every subject of it", () => {
    const v = "likeness_photo.v1";
    expect(
      nextGroup([
        { kind: "likeness_photo", textVersion: v, subject: A },
        { kind: "third_party_content", textVersion: "third_party_content.v1", subject: A },
        { kind: "likeness_photo", textVersion: v, subject: B },
      ]),
    ).toEqual({ kind: "likeness_photo", textVersion: v, subjects: [A, B] });
    expect(nextGroup([])).toBeNull();
  });

  it("acknowledgeProblem names the remedy, not the status", () => {
    expect(acknowledgeProblem(409, "acknowledgement_version_changed")).toBe("version_changed");
    expect(acknowledgeProblem(422, "source_unavailable")).toBe("source_unavailable");
    expect(acknowledgeProblem(503, "acknowledgement_unavailable")).toBe("unavailable");
    expect(acknowledgeProblem(403, "forbidden")).toBe("forbidden");
    expect(acknowledgeProblem(502, "failed")).toBe("failed");
  });
});

describe("the job refusal", () => {
  it("acknowledgement_required is 428 with the database's detail", () => {
    const detail = `kind=likeness_photo version=likeness_photo.v1 subject=${A}`;
    expect(mapCreativeError({ code: "NS400", message: "acknowledgement_required", details: detail })).toEqual({
      status: 428,
      body: { error: "acknowledgement_required", detail },
    });
  });
});

describe("the route's two calls", () => {
  const ORG = "11111111-1111-4111-8111-111111111111";
  const fake = (answer: { data: unknown; error: unknown }) => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const db = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push([fn, args]);
        return answer;
      },
    } as unknown as CreativeDb;
    return { db, calls };
  };

  it("status: asks the database with the member's org, model and inputs", async () => {
    const { db, calls } = fake({ data: { required: [], missing: [] }, error: null });
    expect(await acknowledgementStatus(db, { orgId: ORG, model: "runway-gen4.5", subjects: [A] })).toEqual({
      status: 200,
      body: { required: [], missing: [] },
    });
    expect(calls).toEqual([["rights_acknowledgement_status", { p_org: ORG, p_model: "runway-gen4.5", p_subjects: [A] }]]);
  });

  it("status: bad input never reaches the database, and a malformed answer is a failure", async () => {
    const { db, calls } = fake({ data: { required: "x" }, error: null });
    expect((await acknowledgementStatus(db, { orgId: null, model: "m", subjects: [] })).status).toBe(400);
    expect((await acknowledgementStatus(db, { orgId: ORG, model: "M!", subjects: [] })).status).toBe(400);
    expect((await acknowledgementStatus(db, { orgId: ORG, model: "m", subjects: ["x"] })).status).toBe(400);
    expect((await acknowledgementStatus(db, { orgId: ORG, model: "m", subjects: [A, A, A, A, A] })).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(await acknowledgementStatus(db, { orgId: ORG, model: "m", subjects: [A] })).toEqual({ status: 502, body: { error: "failed" } });
  });

  it("acknowledge: the body is checked, then the database decides", async () => {
    expect(parseAcknowledgeInput({ kind: "face_swap", text_version: "face_swap.v1", subject: A }).ok).toBe(false);
    expect(parseAcknowledgeInput({ kind: "likeness_photo", text_version: "1", subject: A }).ok).toBe(false);
    expect(parseAcknowledgeInput({ kind: "likeness_photo", text_version: "likeness_photo.v1", subject: "x" }).ok).toBe(false);
    const ok = parseAcknowledgeInput({ kind: "likeness_photo", text_version: "likeness_photo.v1", subject: A, user_id: "someone else" });
    expect(ok).toEqual({ ok: true, kind: "likeness_photo", textVersion: "likeness_photo.v1", subject: A });

    const ack = { kind: "likeness_photo", text_version: "likeness_photo.v1", subject: A, created_at: "2026-11-14T10:00:00Z" };
    const { db, calls } = fake({ data: { acknowledgement: ack, replay: false }, error: null });
    expect(await acknowledgeRights(db, { kind: "likeness_photo", textVersion: "likeness_photo.v1", subject: A })).toEqual({
      status: 201,
      body: { acknowledgement: ack, replay: false },
    });
    // Who is never sent: the database reads auth.uid().
    expect(calls).toEqual([["acknowledge_rights", { p_kind: "likeness_photo", p_text_version: "likeness_photo.v1", p_subject: A }]]);
  });

  it("acknowledge: each refusal in the route's own words", async () => {
    const input = { kind: "likeness_photo", textVersion: "likeness_photo.v1", subject: A };
    const cases: Array<[unknown, number, Record<string, unknown>]> = [
      [{ code: "NS409", message: "acknowledgement_version_changed", details: "current=likeness_photo.v2" }, 409, { error: "acknowledgement_version_changed", current: "likeness_photo.v2" }],
      [{ code: "NS400", message: "source_unavailable", details: "subject names no file" }, 422, { error: "source_unavailable" }],
      [{ code: "42501", message: "forbidden" }, 403, { error: "forbidden" }],
      [{ code: "PGRST202", message: "Could not find the function public.acknowledge_rights" }, 503, { error: "acknowledgement_unavailable" }],
      [{ code: "XX000", message: "boom" }, 502, { error: "failed" }],
    ];
    for (const [error, status, body] of cases) {
      const { db } = fake({ data: null, error });
      expect(await acknowledgeRights(db, input)).toEqual({ status, body });
    }
    // An answer about another subject (or none) is not a success.
    const { db } = fake({ data: { acknowledgement: { kind: "likeness_photo", text_version: "likeness_photo.v1", subject: B } }, error: null });
    expect((await acknowledgeRights(db, input)).status).toBe(502);
  });
});

describe("never remembered in the browser", () => {
  it("the dialog keeps nothing in browser storage", () => {
    const src = readFileSync(join(__dirname, "..", "components/studio/RightsAcknowledgementDialog.tsx"), "utf8");
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(src).not.toMatch(/defaultChecked|checked=\{true\}|useState\(true\)/);
  });
});
