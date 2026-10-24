/**
 * The pure half of the custom voice UI (lib/custom-voice.ts, lib/custom-voice-api.ts, slice V3 of docs/CUSTOM_VOICE.md).
 *
 * What would break without these: the switch reading "true" or " 1" as on (the page is meant to be dark until the owner sets the
 * literal 1); the 404 decision missing a spelling of the path; the screen reading a column it must never hold (a provider voice id,
 * the owner reference, a hash); a phrase or upload path from the database being believed when it is not the shape the database
 * makes (the recording would go to another profile's folder); a permission refusal shown as a raw message instead of "not available
 * yet"; an unknown rejection word shown as if it were known; a consent version recorded as v1 for text nobody wrote.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_COLUMNS,
  CONSENT_TEXT_IS_PLACEHOLDER,
  CONSENT_TEXT_VERSION,
  DECLARATION_KEYS,
  PROFILE_COLUMNS,
  actionRefusal,
  classifyRpcError,
  coerceAttachments,
  coerceProfiles,
  customVoiceDecision,
  customVoiceEnabled,
  isCustomVoicePath,
  newIdempotencyKey,
  parseStartedRequest,
  rejectReasonKey,
  sampleTypeFor,
  samplePath,
} from "@/lib/custom-voice";
import { dictionaries } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import { PROVIDER_BRANDS } from "./helpers/brands";

const UID = "3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const PID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const OTHER = "11111111-2222-4333-8444-555555555555";

describe("the switch", () => {
  it("is on only for the literal 1", () => {
    expect(customVoiceEnabled({ CUSTOM_VOICE_ENABLED: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", "on", " 1", "1 ", "01"]) {
      expect(customVoiceEnabled({ CUSTOM_VOICE_ENABLED: v }), String(v)).toBe(false);
    }
  });

  it("reads the real environment at call time and is off when unset", () => {
    const before = process.env.CUSTOM_VOICE_ENABLED;
    try {
      delete process.env.CUSTOM_VOICE_ENABLED;
      expect(customVoiceEnabled()).toBe(false);
      process.env.CUSTOM_VOICE_ENABLED = "1";
      expect(customVoiceEnabled()).toBe(true);
    } finally {
      if (before === undefined) delete process.env.CUSTOM_VOICE_ENABLED;
      else process.env.CUSTOM_VOICE_ENABLED = before;
    }
  });

  it("is never a NEXT_PUBLIC variable (it would be baked into the browser bundle)", () => {
    const src = readFileSync(join(__dirname, "..", "lib", "custom-voice.ts"), "utf8");
    expect(src).not.toMatch(/NEXT_PUBLIC_CUSTOM_VOICE/);
  });
});

describe("which path is the page", () => {
  it.each(["/chronos/agents/voice", "/all-channels/agents/voice", "/chronos/agents/voice/", "/Chronos/Agents/Voice", "/chronos/agents/voice.rsc", "/chronos/agents/%76oice"])(
    "%s is the page",
    (p) => expect(isCustomVoicePath(p)).toBe(true),
  );

  it.each(["/", "/chronos", "/chronos/agents", "/chronos/agents/voices", "/chronos/agents/voice/x", "/chronos/other/voice", "/chronos/voice/voice", "/agents/voice", "/chronos/voice", "/chronos/agents/%zz"])(
    "%s is not the page",
    (p) => expect(isCustomVoicePath(p)).toBe(false),
  );

  it("hides the page with the flag off and leaves it to the gate with the flag on; every other path is untouched either way", () => {
    expect(customVoiceDecision("/chronos/agents/voice", false)).toBe("hide");
    expect(customVoiceDecision("/chronos/agents/voice", true)).toBe("none");
    expect(customVoiceDecision("/chronos/agents", false)).toBe("none");
    expect(customVoiceDecision("/docs/api", false)).toBe("none");
  });
});

describe("the consent record", () => {
  it("records the placeholder version, not v1, while the text is a placeholder, and the version is one the database accepts", () => {
    expect(CONSENT_TEXT_IS_PLACEHOLDER).toBe(true);
    expect(CONSENT_TEXT_VERSION).toBe("v0");
    expect(CONSENT_TEXT_VERSION).toMatch(/^v[0-9]{1,3}$/);
  });

  it("asks for exactly the five declarations the database requires", () => {
    expect([...DECLARATION_KEYS].sort()).toEqual(["no_impersonation", "over_18", "own_voice", "sole_speaker", "voice_data_to_provider"]);
  });

  it("makes idempotency keys the database accepts, and a new one each time", () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).toMatch(/^[A-Za-z0-9_:.-]{1,255}$/);
    expect(a).not.toBe(b);
  });
});

describe("what the screen is allowed to read", () => {
  it("selects no provider voice id, owner reference, hash, idempotency key or path", () => {
    const columns = PROFILE_COLUMNS.split(",");
    for (const banned of ["provider_voice_id", "provider", "owner_ref", "sample_sha256", "idempotency_key", "request_hash", "user_id", "org_id"]) {
      expect(columns, banned).not.toContain(banned);
    }
    expect(PROFILE_COLUMNS).not.toContain("*");
    expect(ATTACHMENT_COLUMNS).not.toContain("*");
  });

  it("drops what a row carries beyond the view, and reads an unknown status or sample state as unknown", () => {
    const rows = coerceProfiles([
      {
        id: PID,
        name: "My voice",
        status: "approved",
        reject_reason: null,
        sample_state: "stored",
        keep_sample: false,
        created_at: "2026-10-24T10:00:00Z",
        provider_voice_id: "ABCDEFGHIJ0123456789",
        owner_ref: "a".repeat(32),
        sample_sha256: "b".repeat(64),
      },
      { id: OTHER, name: "Odd", status: "paused", sample_state: "elsewhere" },
      { id: "not-a-uuid", name: "x" },
      { id: OTHER, name: 5 },
      null,
    ]);
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0]).sort()).toEqual(["createdAt", "id", "keepSample", "name", "rejectReason", "sampleState", "status"]);
    expect(JSON.stringify(rows)).not.toMatch(/ABCDEFGHIJ0123456789|bbbbbbbb|aaaaaaaa/);
    expect(rows[1].status).toBe("unknown");
    expect(rows[1].sampleState).toBe("unknown");
  });

  it("reads only active, well-formed attachments", () => {
    expect(
      coerceAttachments([
        { voice_profile_id: PID, channel_id: "chronos", slot: "narrator", status: "active" },
        { voice_profile_id: PID, channel_id: "chronos", slot: "narrator", status: "revoked" },
        { voice_profile_id: PID, channel_id: "chronos", slot: "third", status: "active" },
        { voice_profile_id: "x", channel_id: "chronos", slot: "narrator", status: "active" },
      ]),
    ).toEqual([{ profileId: PID, channelId: "chronos", slot: "narrator" }]);
    expect(coerceAttachments("nope")).toEqual([]);
  });
});

describe("the started request", () => {
  const good = {
    ok: true,
    profile_id: PID,
    phrase: "apple river candle window garden pencil",
    upload_prefix: `${UID}/${PID}/`,
    expires_at: "2026-10-24T12:00:00Z",
  };

  it("accepts the database's own answer", () => {
    expect(parseStartedRequest(good)).toEqual({
      profileId: PID,
      phrase: "apple river candle window garden pencil",
      prefix: `${UID}/${PID}/`,
      expiresAt: "2026-10-24T12:00:00Z",
    });
  });

  it("refuses an upload prefix that is not this profile's folder (the recording would go elsewhere)", () => {
    expect(parseStartedRequest({ ...good, upload_prefix: `${UID}/${OTHER}/` })).toBeNull();
    expect(parseStartedRequest({ ...good, upload_prefix: `${UID}/${PID}/../x/` })).toBeNull();
    expect(parseStartedRequest({ ...good, upload_prefix: `${PID}/` })).toBeNull();
    expect(parseStartedRequest({ ...good, upload_prefix: undefined })).toBeNull();
  });

  it("refuses a phrase that is not plain lower-case words, so it can never carry markup", () => {
    for (const phrase of ["<b>apple</b> river candle", "apple river", "Apple River Candle", "apple  river candle", null, 5, ""]) {
      expect(parseStartedRequest({ ...good, phrase }), String(phrase)).toBeNull();
    }
  });

  it("refuses an answer that is not ok, or has no profile", () => {
    expect(parseStartedRequest({ ...good, ok: false })).toBeNull();
    expect(parseStartedRequest({ ...good, profile_id: "x" })).toBeNull();
    expect(parseStartedRequest(null)).toBeNull();
  });

  it("drops an expiry it cannot read rather than showing a wrong time", () => {
    expect(parseStartedRequest({ ...good, expires_at: "soon" })?.expiresAt).toBeNull();
  });

  it("builds the upload path from the prefix and the extension", () => {
    expect(samplePath(`${UID}/${PID}/`, "webm")).toBe(`${UID}/${PID}/sample.webm`);
  });
});

describe("the recording's type", () => {
  it("declares the base type only (codecs are not sent) and names the extension the bucket's rule accepts", () => {
    expect(sampleTypeFor("audio/webm;codecs=opus")).toEqual({ type: "audio/webm", ext: "webm" });
    expect(sampleTypeFor("audio/webm")).toEqual({ type: "audio/webm", ext: "webm" });
    expect(sampleTypeFor("audio/ogg; codecs=opus")).toEqual({ type: "audio/ogg", ext: "ogg" });
    expect(sampleTypeFor("audio/mp4")).toEqual({ type: "audio/mp4", ext: "m4a" });
    expect(sampleTypeFor("AUDIO/WEBM")).toEqual({ type: "audio/webm", ext: "webm" });
  });

  it("has no type for anything the bucket would not take", () => {
    for (const m of ["video/webm", "text/html", "", null, undefined, "audio/midi"]) expect(sampleTypeFor(m as string)).toBeNull();
  });
});

describe("errors become closed words", () => {
  it("reads a permission refusal on the request function as 'not available yet'", () => {
    expect(classifyRpcError({ code: "42501", message: "permission denied for function request_voice_clone" })).toBe("notAvailable");
  });

  it("reads a function or table that is not there (0117 not applied) as 'not available yet' too", () => {
    expect(classifyRpcError({ code: "PGRST202", message: "Could not find the function" })).toBe("notAvailable");
    expect(classifyRpcError({ code: "42883", message: "function does not exist" })).toBe("notAvailable");
    expect(classifyRpcError({ code: "PGRST205", message: "Could not find the table 'public.voice_profiles'" })).toBe("notAvailable");
    expect(classifyRpcError({ code: "42501", message: "permission denied for table voice_profiles" })).toBe("notAvailable");
  });

  it("tells a signed-out session and a role refusal apart from a missing grant", () => {
    expect(classifyRpcError({ code: "42501", message: "sign in first" })).toBe("signedOut");
    expect(classifyRpcError({ code: "42501", message: "forbidden" })).toBe("forbidden");
    expect(classifyRpcError({ code: "PGRST301", message: "JWT expired" })).toBe("signedOut");
  });

  it("maps the database's hints and custom codes", () => {
    const hint = (h: string) => classifyRpcError({ code: "22023", message: "x", hint: h });
    expect(hint("name_real_person")).toBe("nameRealPerson");
    expect(hint("name_length")).toBe("nameLength");
    expect(hint("name_characters")).toBe("nameCharacters");
    expect(hint("name_link")).toBe("nameLink");
    expect(hint("declarations_incomplete")).toBe("declarations");
    expect(hint("consent_version")).toBe("consentVersion");
    expect(hint("org_required")).toBe("orgRequired");
    expect(classifyRpcError({ code: "NS429", message: "x", hint: "rate_limited" })).toBe("rateLimited");
    expect(classifyRpcError({ code: "NS429", message: "x", hint: "voice_slots" })).toBe("voiceSlots");
    expect(classifyRpcError({ code: "NS409", message: "x" })).toBe("keyReused");
    expect(classifyRpcError({ code: "P0002", message: "not_found" })).toBe("notFound");
  });

  it("calls everything else failed, and a fetch that never arrived a network problem", () => {
    expect(classifyRpcError({ code: "XX000", message: "boom" })).toBe("failed");
    expect(classifyRpcError(null)).toBe("failed");
    expect(classifyRpcError({ message: "Failed to fetch" })).toBe("network");
  });
});

describe("why a voice was not created", () => {
  it("groups the closed words by what the person can do", () => {
    expect(rejectReasonKey("sample_timeout")).toBe("reasonSampleTimeout");
    expect(rejectReasonKey("verification_failed")).toBe("reasonPhrase");
    expect(rejectReasonKey("provider_not_enabled")).toBe("reasonNotEnabled");
    expect(rejectReasonKey("provider_unavailable")).toBe("reasonOurSide");
    expect(rejectReasonKey("worker_lost")).toBe("reasonOurSide");
    expect(rejectReasonKey("not_audio")).toBe("reasonNotAudio");
    expect(rejectReasonKey("sample_too_long")).toBe("reasonTooLong");
  });

  it("never shows a word it does not know, including names that exist on every object", () => {
    for (const w of ["something_new", "", null, undefined, "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(rejectReasonKey(w), String(w)).toBe("reasonUnknown");
    }
  });

  it("has a sentence in every language for every reason it can return", () => {
    const keys = ["reasonSampleTimeout", "reasonPhrase", "reasonTooLong", "reasonTooLarge", "reasonNotAudio", "reasonNotReceived", "reasonNotEnabled", "reasonProvider", "reasonOurSide", "reasonUnknown"] as const;
    for (const locale of ["en", "ru", "uz"] as Locale[]) for (const k of keys) expect(dictionaries[locale].customVoice[k].length, `${locale} ${k}`).toBeGreaterThan(5);
  });
});

describe("the database's refusals", () => {
  it("maps approve and attach words, and reads an answer with no ok as unknown", () => {
    expect(actionRefusal({ ok: true })).toBeNull();
    expect(actionRefusal({ ok: false, error: "not_tested" })).toBe("notTested");
    expect(actionRefusal({ ok: false, error: "not_verified" })).toBe("notVerified");
    expect(actionRefusal({ ok: false, error: "not_testing" })).toBe("notTesting");
    expect(actionRefusal({ ok: false, error: "not_approved" })).toBe("notApproved");
    expect(actionRefusal({ ok: false, error: "voice_in_use" })).toBe("voiceInUse");
    expect(actionRefusal({ ok: false, error: "whatever" })).toBe("unknown");
    // No error and no confirmation is not success (CLAUDE.md rule 5).
    expect(actionRefusal(null)).toBe("unknown");
    expect(actionRefusal({})).toBe("unknown");
  });
});

describe("the copy", () => {
  const en = dictionaries.en.customVoice;
  const placeholders = (s: string) => (s.match(/\{[a-z]+\}/g) ?? []).sort().join(",");

  it("carries every key in all three languages, non-empty, with the same placeholders", () => {
    for (const locale of ["ru", "uz"] as Locale[]) {
      const d = dictionaries[locale].customVoice as Record<string, string>;
      expect(Object.keys(d).sort()).toEqual(Object.keys(en).sort());
      for (const [k, v] of Object.entries(d)) {
        expect(v.trim().length, `${locale} ${k}`).toBeGreaterThan(0);
        expect(placeholders(v), `${locale} ${k}`).toBe(placeholders((en as Record<string, string>)[k]));
      }
    }
  });

  it("names no provider or model in any language", () => {
    for (const locale of ["en", "ru", "uz"] as Locale[]) {
      for (const [k, v] of Object.entries(dictionaries[locale].customVoice)) expect(v, `${locale} ${k}`).not.toMatch(PROVIDER_BRANDS);
    }
  });

  it("marks the consent text as awaiting counsel in every language, and writes no legal text of its own", () => {
    expect(en.consentPlaceholderMarker).toMatch(/counsel review required/i);
    for (const locale of ["ru", "uz"] as Locale[]) expect(dictionaries[locale].customVoice.consentPlaceholderMarker.length).toBeGreaterThan(10);
  });

  it("says plainly that the check does not prove whose voice it is", () => {
    expect(en.limitsBody).toMatch(/does not prove whose voice it is/);
  });

  it("flags the ru and uz files as machine drafts", () => {
    for (const f of ["en", "ru", "uz"]) {
      expect(readFileSync(join(__dirname, "..", "lib", "i18n", "custom-voice", `${f}.ts`), "utf8")).toMatch(/machine draft|Машинный черновик|Mashina qoralamasi/);
    }
  });
});
