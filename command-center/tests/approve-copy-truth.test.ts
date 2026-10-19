/**
 * The review panel's "Approve and publish" button files a `review_intents` row that nothing reads (see
 * docs/product/APPROVE_PUBLISH_DESIGN.md), and every upload is private: a person makes a video public on YouTube.
 * Copy that says the button publishes, or that a later run carries the request out, was false and was removed in
 * all three languages. This pins it: if one of those sentences comes back, this fails.
 *
 * When the button is really wired (the design's Phase 1), change this test in the same pull request, on purpose.
 */
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";

const dicts = { en, ru, uz } as const;

/** Every string in a dictionary, with the path it lives at, so a failure names the key to fix. */
function strings(node: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof node === "string") out.push([path, node]);
  else if (Array.isArray(node)) node.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) strings(v, `${path}.${k}`, out);
  return out;
}

/** Sentences that promised the button publishes or that the next run acts on it. One list per language. */
const OVERCLAIMS: Record<keyof typeof dicts, RegExp[]> = {
  en: [
    /Only then does it go public/i,
    /files a request the next run carries out/i,
    /take the video public on its next run/i,
    /next run will act on it/i,
    /next pipeline run carries it out/i,
    /press(es)? Approve and publish/i,
    /Going public is your button/i,
    /going public is your button/i,
    /press(ed)? Publish\b/,
    /private until you approve/i,
    /until you approve (them|it) on the video page/i,
    /approve every video before it (goes public|airs)/i,
  ],
  ru: [
    /Следующий запуск это выполнит/,
    /выполняет его следующий запуск/,
    /выполнит следующий запуск/,
    /нажимаете «Одобрить и опубликовать»/,
    /Только после этого оно становится публичным/,
    /Опубликовать — ваша кнопка/,
    /нажимаете «Опубликовать»/,
    /приватн\w+,? пока вы (его |их )?не одобрите/i,
    /одобряйте каждое видео до публикации/,
  ],
  uz: [
    /Keyingi run uni bajaradi/,
    /keyingi konveyer ishga tushganda/,
    /keyingi ishga tushirish bajaradigan/,
    /keyingi ishga tushirishda ommaviy/,
    /«Tasdiqlash va nashr qilish»ni bosasiz/,
    /Shundan keyingina u ommaviy/,
    /Ommaviy qilish — sizning tugmangiz/,
    /ommaviy qilish — sizning tugmangiz/,
    /«Nashr qilish»ni bosganingizda/,
    /siz tasdiqlaguningizcha (yopiq|shaxsiy)/i,
    /tasdiqlaguningizcha yopiq/i,
  ],
};

describe("no copy says the Approve and publish button publishes", () => {
  it.each(["en", "ru", "uz"] as const)("%s has none of the old over-claiming sentences", (loc) => {
    const hits: string[] = [];
    for (const [path, s] of strings(dicts[loc], loc)) {
      for (const re of OVERCLAIMS[loc]) if (re.test(s)) hits.push(`${path}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it.each(["en", "ru", "uz"] as const)("%s: what the panel says after a click and in the sheets is a record, not a promise of a run", (loc) => {
    const d = dicts[loc];
    // After a click the panel must not promise that any later run acts, and must point at YouTube for going public.
    for (const s of [d.review.filed, d.review.queueHint, d.confirmSheets.rvApproveBody]) {
      expect(s, `${loc}: ${s}`).toMatch(/YouTube/);
      expect(s, `${loc}: ${s}`).not.toMatch(/next run|следующ\w+ запуск|keyingi (run|ishga|konveyer)/i);
    }
    // The re-render buttons are dead as well; their sheets must not promise a render or a price either.
    for (const s of [d.confirmSheets.rvRegenBody, d.confirmSheets.rvScriptBody]) {
      expect(s, `${loc}: ${s}`).not.toMatch(/next run|следующ\w+ запуск|keyingi (run|ishga|konveyer)/i);
    }
  });

  it("en: the sheet says plainly that it does not publish and that going public is done on YouTube", () => {
    expect(en.confirmSheets.rvApproveBody).toContain("does not publish it");
    expect(en.confirmSheets.rvApproveBody).toContain("make it public on YouTube");
    expect(en.review.filed).toContain("Nothing is carried out automatically yet");
  });

  it("the button label is unchanged: it is a product decision the owner has not made", () => {
    expect(en.review.approve).toBe("Approve and publish");
    expect(ru.review.approve).toBe("Одобрить и опубликовать");
    expect(uz.review.approve).toBe("Tasdiqlash va nashr qilish");
  });
});
