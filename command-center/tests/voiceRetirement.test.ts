import { describe, expect, it } from "vitest";
import { DEFAULT_VOICES, channelVoiceNotices, isDefaultVoice, offeredVoices, suggestionInAccount, voiceRetirement } from "../lib/voiceRetirement";
import { VOICES, isVoiceId } from "../lib/ttsModels";

const GEORGE = "JBFqnCBsd6RMkjVDRZzb"; // a Default voice in lib/voices.json
const ADAM = "pNInz6obpgDQGcFmaJgB"; // not a Default voice

describe("voice retirement on the Create page", () => {
  it("still offers a Default voice on its last day (UTC) and marks it as leaving", () => {
    // 23:30 on 31 Dec in UTC is already 1 Jan in Tashkent: the run judges in UTC, and so does the picker.
    const lastMinute = new Date("2026-12-31T23:30:00Z");
    expect(voiceRetirement(GEORGE, lastMinute)).toBe("leaving");
    expect(offeredVoices(VOICES, lastMinute).map((v) => v.id)).toContain(GEORGE);
  });

  it("hides a Default voice from 1 Jan 2027 and replaces it with nothing", () => {
    const after = new Date("2027-01-01T00:00:00Z");
    expect(voiceRetirement(GEORGE, after)).toBe("retired");
    const offered = offeredVoices(VOICES, after);
    expect(offered.map((v) => v.id)).not.toContain(GEORGE);
    // Only Default voices drop out; nothing is added in their place.
    expect(offered.length).toBe(VOICES.filter((v) => !isDefaultVoice(v.id)).length);
    for (const v of offered) expect(VOICES).toContain(v);
  });

  it("leaves a voice with no known retirement alone", () => {
    expect(voiceRetirement(ADAM, new Date("2030-01-01T00:00:00Z"))).toBeNull();
    expect(voiceRetirement("not-an-id", new Date("2030-01-01T00:00:00Z"))).toBeNull();
  });

  it("recognises a typed id with padding, the same as the run", () => {
    expect(voiceRetirement(` ${GEORGE} `, new Date("2027-02-01T00:00:00Z"))).toBe("retired");
  });

  it("lists only real voice ids", () => {
    for (const [id, row] of Object.entries(DEFAULT_VOICES)) {
      expect(isVoiceId(id), id).toBe(true);
      expect(isVoiceId(row.suggestedId), row.suggested).toBe(true);
    }
  });
});

describe("a channel's saved Default voices", () => {
  const before = new Date("2026-11-22T10:00:00Z");

  it("names the narrator and the quote voice, each with its state", () => {
    const notices = channelVoiceNotices({ elevenlabs_voice_id: GEORGE, elevenlabs_secondary_voice_id: "nPczCjzI2devNBz1zQrb" }, before);
    expect(notices.map((n) => [n.slot, n.name, n.state])).toEqual([
      ["narrator", "George", "leaving"],
      ["quote", "Brian", "leaving"],
    ]);
    expect(channelVoiceNotices({ elevenlabs_voice_id: GEORGE }, new Date("2027-01-01T00:00:00Z"))[0].state).toBe("retired");
  });

  it("is one notice when the narrator and the quote voice are the same Default voice", () => {
    const notices = channelVoiceNotices({ elevenlabs_voice_id: GEORGE, elevenlabs_secondary_voice_id: ` ${GEORGE}` }, before);
    expect(notices.map((n) => [n.slot, n.name])).toEqual([["both", "George"]]);
  });

  it("says nothing for an Edge channel, a non-Default voice, the narrator sentinel or no config", () => {
    expect(channelVoiceNotices({ tts_provider: "edge", elevenlabs_voice_id: GEORGE }, before)).toEqual([]);
    expect(channelVoiceNotices({ elevenlabs_voice_id: ADAM, elevenlabs_secondary_voice_id: "narrator" }, before)).toEqual([]);
    expect(channelVoiceNotices(null, before)).toEqual([]);
  });

  it("points at ElevenLabs' suggestion only when the account's own list has it", () => {
    const [george] = channelVoiceNotices({ elevenlabs_voice_id: GEORGE }, before);
    expect(suggestionInAccount(george, null)).toBe("unknown");
    expect(suggestionInAccount(george, [ADAM])).toBe("missing");
    expect(suggestionInAccount(george, [ADAM, DEFAULT_VOICES[GEORGE].suggestedId])).toBe("in");
  });
});
