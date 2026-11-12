import { describe, expect, it } from "vitest";
import { CONFIRM_RESULTS } from "../lib/connect-picker";
import { isYoutubeChannelInUse, parseVaultResult, storeErrorResult, VAULT_RESULTS } from "../lib/channel-tokens";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { connectPickerEn } from "../lib/i18n/connect-picker/en";
import { connectPickerRu } from "../lib/i18n/connect-picker/ru";
import { connectPickerUz } from "../lib/i18n/connect-picker/uz";

/** Migration 0141: one YouTube channel is connected to at most one workspace. The database refuses with SQLSTATE 23P01 and the
 *  hint `youtube_channel_in_use`; the Command Center says so in plain words and never shows the database's text. */
const REFUSAL = {
  code: "23P01",
  message: "youtube_channel_in_use: this YouTube channel is already connected to another workspace; disconnect it there first",
  hint: "youtube_channel_in_use",
};

describe("a YouTube channel connected to another workspace (0141)", () => {
  it("is recognised by the stable code and our own marker only", () => {
    expect(isYoutubeChannelInUse(REFUSAL)).toBe(true);
    expect(isYoutubeChannelInUse({ ...REFUSAL, hint: undefined })).toBe(true);
    expect(isYoutubeChannelInUse({ ...REFUSAL, message: "x" })).toBe(true);
    expect(isYoutubeChannelInUse({ ...REFUSAL, code: "23505" })).toBe(false);
    expect(isYoutubeChannelInUse({ code: "23P01", message: "conflicting key value violates exclusion constraint", hint: null })).toBe(false);
    expect(isYoutubeChannelInUse({})).toBe(false);
    expect(storeErrorResult(REFUSAL)).toBe("channel_in_use");
  });

  it("is a result word the channels page renders, and the pick screen answers", () => {
    expect(VAULT_RESULTS).toContain("channel_in_use");
    expect(parseVaultResult("channel_in_use")).toBe("channel_in_use");
    expect(CONFIRM_RESULTS).toContain("channel_in_use");
  });

  it("reads the same sentence in uz, en and ru, in workspace words, with nothing from the database in it", () => {
    expect(en.channelTokens.results.channel_in_use).toBe(
      "This YouTube channel is already connected to another workspace. Disconnect it there first.",
    );
    expect(ru.channelTokens.results.channel_in_use).toBe(
      "Этот канал YouTube уже подключён к другому рабочему пространству. Сначала отключите его там.",
    );
    expect(uz.channelTokens.results.channel_in_use).toBe(
      "Bu YouTube kanali allaqachon boshqa ish maydoniga ulangan. Avval uni oʻsha yerda uzing.",
    );
    // the pick screen: the same sentence, and that nothing was connected here
    for (const [dict, base] of [
      [connectPickerEn, en],
      [connectPickerRu, ru],
      [connectPickerUz, uz],
    ] as const) {
      const line = dict.pick.errors.channel_in_use;
      expect(line.startsWith(base.channelTokens.results.channel_in_use)).toBe(true);
      expect(line.length).toBeGreaterThan(base.channelTokens.results.channel_in_use.length);
      for (const leak of ["youtube_channel_in_use", "23P01", "org", "UC"]) expect(line).not.toContain(leak);
    }
    // the words the site already uses for a workspace
    expect(en.signup.wsCreate).toMatch(/workspace/);
    expect(ru.signup.wsCreate).toMatch(/пространство/);
    expect(uz.signup.wsCreate).toMatch(/Ish maydon/);
  });

  it("keeps the three pick-screen dictionaries in key parity", () => {
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(connectPickerRu.pick.errors)).toEqual(keys(connectPickerEn.pick.errors));
    expect(keys(connectPickerUz.pick.errors)).toEqual(keys(connectPickerEn.pick.errors));
    expect(keys(ru.channelTokens.results)).toEqual(keys(en.channelTokens.results));
    expect(keys(uz.channelTokens.results)).toEqual(keys(en.channelTokens.results));
  });
});
