/**
 * What the app says about approving must be what the code does. Since migration 0112 "Approve" RECORDS a decision, bound to
 * the exact cut and good for 24 hours; it does not make a video public. Every video is uploaded as private and stays private
 * until a person makes it public on YouTube (a worker that does it for an approved video, Phase 1b, is not built). Copy
 * that says the button publishes, that a later run carries the request out, or that a video is private "until you approve"
 * was false and was removed in all three languages. This pins it: if one of those sentences comes back, this fails.
 *
 * When Phase 1b makes an approved video public, change this test in the same pull request, on purpose.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { APPROVE_REASONS, type ApprovalBlocker } from "../lib/videoApproval";

const dicts = { en, ru, uz } as const;
const REPO = join(__dirname, "..", "..");

/** Every string in a dictionary, with the path it lives at, so a failure names the key to fix. */
function strings(node: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof node === "string") out.push([path, node]);
  else if (Array.isArray(node)) node.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) strings(v, `${path}.${k}`, out);
  return out;
}

/** Sentences that promised the button publishes, that the next run acts on it, or that privacy lasts "until you approve". */
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
    /private until approved/i,
    /private[^.]*until you approve/i,
    /approve every video before it (goes public|airs)/i,
    /nothing goes public until (you|someone) (approve|presses Approve)/i,
    /waits for your approval before anything reaches YouTube/i,
    /Approve and publish/,
  ],
  ru: [
    /Следующий запуск это выполнит/,
    /выполняет его следующий запуск/,
    /выполнит следующий запуск/,
    /нажимаете «Одобрить и опубликовать»/,
    /Только после этого оно становится публичным/,
    /Опубликовать — ваша кнопка/,
    /публикация — ваша кнопка/i,
    /нажимаете «Опубликовать»/,
    /приватн\w+,? пока вы (его |их )?не одобрите/i,
    /приватно до одобрения/i,
    /одобряйте каждое видео до публикации/,
    /Одобрить и опубликовать/,
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
    /tasdiqlanguncha (yopiq|shaxsiy)/i,
    /Tasdiqlash va nashr qilish/,
  ],
};

/**
 * The one place the old label may still appear: the alt text of the landing page's screenshot, which describes the picture
 * as it is (an image taken before the button was renamed). It has to be re-shot; until then the alt describes the image.
 */
const EXEMPT = /\.shotAlt$|^ru\.inbox\.reply\.approve$/;   // (the second is the comment inbox: approving a REPLY does post it)

describe("no copy says the Approve button publishes", () => {
  it.each(["en", "ru", "uz"] as const)("%s has none of the old over-claiming sentences", (loc) => {
    const hits: string[] = [];
    for (const [path, s] of strings(dicts[loc], loc)) {
      if (EXEMPT.test(path)) continue;
      for (const re of OVERCLAIMS[loc]) if (re.test(s)) hits.push(`${path}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it("the screenshot's alt text is the only string left that names the old label", () => {
    const left: string[] = [];
    for (const loc of ["en", "ru", "uz"] as const) {
      for (const [path, s] of strings(dicts[loc], loc)) {
        if (/Approve and publish|Одобрить и опубликовать|Tasdiqlash va nashr qilish/.test(s) && !/^ru\.inbox\.reply\.approve$/.test(path)) left.push(path.replace(/^(en|ru|uz)\./, ""));
      }
    }
    expect(left.every((p) => /\.shotAlt$/.test(p)), left.join(", ")).toBe(true);
  });

  it("the old sheets of the two re-render buttons, which promised a render and a price, are gone", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const c = dicts[loc].confirmSheets as unknown as Record<string, unknown>;
      for (const k of ["rvRegenTitle", "rvRegenBody", "rvScriptTitle", "rvScriptBody"]) expect(c[k], `${loc}.${k}`).toBeUndefined();
      expect((dicts[loc].review as unknown as Record<string, unknown>).filed).toBeUndefined();
    }
  });
});

describe("what the review panel says is what the code does", () => {
  it.each(["en", "ru", "uz"] as const)("%s: after an approval it still says the video is private and points at YouTube", (loc) => {
    const d = dicts[loc];
    // The banner states what is known (it was uploaded as private), never a present fact about YouTube it cannot know.
    for (const s of [d.review.approvedBy, d.review.approvedAnon, d.review.expiredBy, d.review.expiredAnon]) {
      expect(s, `${loc}: ${s}`).not.toMatch(/still private|по-прежнему приватн|hamon shaxsiy/i);
    }
    for (const s of [d.review.queueHint, d.confirmSheets.rvApproveBody, d.review.makePublicBody]) {
      expect(s, `${loc}: ${s}`).toMatch(/YouTube/);
      expect(s, `${loc}: ${s}`).not.toMatch(/next run|следующ\w+ запуск|keyingi (run|ishga|konveyer)/i);
    }
    expect(d.review.makePublicBody.length).toBeGreaterThan(20);
    expect(d.review.studioLink).toMatch(/YouTube Studio/);
  });

  it("en: the sheet says plainly that approving does not make it public, and that it holds for 24 hours for this version", () => {
    const b = en.confirmSheets.rvApproveBody;
    expect(b).toContain("does not make it public");
    expect(b).toContain("make it public on YouTube");
    expect(b).toContain("24 hours");
    expect(b).toContain("exact version");
    expect(en.review.approvedBy).toContain("The video was uploaded as private; approving does not make it public.");
    expect(en.review.approvedAnon).toContain("The video was uploaded as private; approving does not make it public.");
    expect(en.review.expiredBy).toContain("was uploaded as private");
  });

  it("the key is called Approve, not Approve and publish: it records a decision; the bot does not make the video public", () => {
    expect(en.review.approve).toBe("Approve");
    expect(ru.review.approve).toBe("Одобрить");
    expect(uz.review.approve).toBe("Tasdiqlash");
  });

  it.each(["en", "ru", "uz"] as const)("%s: the two re-render buttons say they are not available, and do not promise a run", (loc) => {
    const s = dicts[loc].review.notAvailableYet;
    expect(s.length).toBeGreaterThan(30);
    expect(s).not.toMatch(/next run|следующ\w+ запуск|keyingi (run|ishga|konveyer)/i);
  });

  it("the cross-post message is true again: only an approved video can be posted, and approving is possible", () => {
    expect(en.publish.blocker.not_approved).toContain("Approve this video first");
  });
});

describe("the reasons and blockers exist in all three languages", () => {
  const blockers: ApprovalBlocker[] = ["held", "rejected", "already_public", "gate_blocked", "gate_unknown", "no_preview", "cut_unknown", "not_admin", "not_member"];

  it.each(["en", "ru", "uz"] as const)("%s has a sentence for every blocker and every reason word the database can answer", (loc) => {
    const r = dicts[loc].review;
    expect(Object.keys(r.blocker).sort()).toEqual([...blockers].sort());
    expect(Object.keys(r.reasons).sort()).toEqual([...APPROVE_REASONS, "failed"].sort());
    for (const s of [...Object.values(r.blocker), ...Object.values(r.reasons)]) expect(s.trim().length, `${loc}: ${s}`).toBeGreaterThan(8);
  });

  it("no customer-facing sentence names a role", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const r = dicts[loc].review;
      for (const s of [...Object.values(r.blocker), ...Object.values(r.reasons), r.queueHint, r.notAvailableYet]) {
        expect(s, `${loc}: ${s}`).not.toMatch(/\b(owner|editor|viewer)\b|владелец|редактор|наблюдател|egasi|muharrir|kuzatuvchi/i);
      }
    }
  });
});

describe("the page metadata", () => {
  it("does not say the app waits for an approval before anything goes public", () => {
    const layout = readFileSync(join(__dirname, "..", "app", "layout.tsx"), "utf8");
    expect(layout).not.toMatch(/waits for your approval/i);
    expect(layout).toContain("nothing goes public without you");
  });
});

describe("CLAUDE.md rule 3 tells the truth", () => {
  const rules = readFileSync(join(REPO, "CLAUDE.md"), "utf8");
  it("no longer says the next pipeline run reads the dashboard's row and acts", () => {
    expect(rules).not.toMatch(/the next\s+pipeline run reads it and acts/i);
  });
  it("says what is read, what Approve records, and that Phase 1b is not built", () => {
    expect(rules).toMatch(/approve_video_publish/);
    expect(rules).toMatch(/Phase 1b \(the bot flips privacy\) is not built yet/);
  });
});
