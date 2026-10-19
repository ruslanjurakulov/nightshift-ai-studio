/**
 * What the app says about approving must be what the code does. Since migration 0112 "Approve" RECORDS a decision, bound to
 * the exact cut and good for 24 hours; it does not make a video public. Every video is uploaded as private and stays private
 * until a person makes it public on YouTube. Copy that says the button publishes, that a later run carries the request out,
 * or that a video is private "until you approve" was false and was removed in all three languages. This pins it: if one of
 * those sentences comes back, this fails.
 *
 * Phase 1b (migration 0113) adds ONE exception, on purpose and per channel: where the channel's administrators switched
 * "publish when approved" on (default OFF), the button may read "Approve and publish", and the panel says what the database
 * recorded. So the label lives at exactly one key (`review.approvePublish`) and the panel shows it only behind the switch; the
 * only sentence that says "published" is the one for a request a read-back of YouTube ended as public; every sentence that
 * describes the switched-on flow says YouTube may still keep the video private and that the switch can be turned off.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { APPROVE_REASONS, type ApprovalBlocker } from "../lib/videoApproval";
import { RETRY_ERRORS, VISIBILITY_REASONS } from "../lib/visibilityRequest";

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
// (the second is the comment inbox: approving a REPLY does post it; the third is the label of the switched-on flow, below)
const EXEMPT = /\.shotAlt$|^ru\.inbox\.reply\.approve$|^(en|ru|uz)\.review\.approvePublish$/;

describe("no copy says the Approve button publishes", () => {
  it.each(["en", "ru", "uz"] as const)("%s has none of the old over-claiming sentences", (loc) => {
    const hits: string[] = [];
    for (const [path, s] of strings(dicts[loc], loc)) {
      if (EXEMPT.test(path)) continue;
      for (const re of OVERCLAIMS[loc]) if (re.test(s)) hits.push(`${path}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it("the screenshot's alt text and the switched-on label are the only strings left that name the old label", () => {
    const left: string[] = [];
    for (const loc of ["en", "ru", "uz"] as const) {
      for (const [path, s] of strings(dicts[loc], loc)) {
        if (/Approve and publish|Одобрить и опубликовать|Tasdiqlash va nashr qilish/.test(s) && !/^ru\.inbox\.reply\.approve$/.test(path)) left.push(path.replace(/^(en|ru|uz)\./, ""));
      }
    }
    expect(left.every((p) => /\.shotAlt$|^review\.approvePublish$/.test(p)), left.join(", ")).toBe(true);
    // and the label is there in all three languages, at that one key
    expect(left.filter((p) => p === "review.approvePublish")).toHaveLength(3);
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

describe("publish when approved (migration 0113): no copy claims publishing unless the channel's switch is on and the read-back confirms", () => {
  const SRC = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
  const walk = (dir: string): string[] =>
    readdirSync(join(__dirname, "..", dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [],
    );

  it("the switched-on label is rendered only behind the channel's switch, and nowhere else", () => {
    const panel = SRC("components/review/ReviewPanel.tsx");
    const uses = panel.split("\n").filter((l) => /\bapprovePublish\b/.test(l));
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const l of uses) expect(l, l).toMatch(/publishing/);
    // `publishing` is the switch and nothing else, and never when the channel publishes by itself
    expect(panel).toContain("const publishing = publishOnApprove && !autoPublish;");
    // the page hands over the switch as read from the channel row: true only for an explicit true, false on any error
    const page = SRC("app/(app)/[channel]/videos/[id]/page.tsx");
    // ... whatever the release flag says (a channel that has it on must not say "Approve" over a button that publishes); the flag
    // (server, default off, lib/server/release-flags.ts) hides only the way to turn it on
    expect(page).toContain("publishOnApprove = !sw.error && (sw.data as { publish_on_approve?: unknown } | null)?.publish_on_approve === true;");
    expect(page).toContain("visibilityRequest = (released || publishOnApprove) && !vreq.error ? parseVisibilityRow(vreq.data) : null;");
    // no other component or page names the label
    const others = [...walk("components"), ...walk("app")].filter((f) => !/ReviewPanel\.tsx$/.test(f) && /\bapprovePublish\b/.test(SRC(f)));
    expect(others).toEqual([]);
    // and with the switch off the button and its hint are the old ones
    expect(panel).toContain("{publishing ? t.review.approvePublish : t.review.approve}");
    expect(panel).toContain("publishing\n                    ? t.review.queueHintPublish\n                    : t.review.queueHint");
  });

  it("only a request that a read-back of YouTube ended as public is called published", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const d = dicts[loc];
      // (\b does not see Cyrillic: a letter on either side is what makes it a different word)
      const claim = /(?<![\p{L}])(Published|Опубликовано|Nashr qilindi)(?![\p{L}])/u;
      const owners = [
        ...strings(d.review.visibility, `${loc}.review.visibility`),
        ...strings({ a: d.review.queueHintPublish, b: d.review.approvedByPublish, c: d.review.approvedAnonPublish, e: d.review.expiredByPublish,
                     f: d.review.expiredAnonPublish, g: d.review.makePublicFallbackBody }, `${loc}.review`),
        ...strings({ a: d.confirmSheets.rvApprovePublishBody, b: d.confirmSheets.publishOnBody, c: d.confirmSheets.publishOnTitle }, `${loc}.confirmSheets`),
        ...strings({ a: d.channels.publishOnHintOn, b: d.channels.publishOnHintOff, c: d.channels.autoOffHintPublish }, `${loc}.channels`),
      ];
      const claims = owners.filter(([, s]) => claim.test(s)).map(([p]) => p.replace(`${loc}.`, ""));
      expect(claims.sort(), loc).toEqual(["review.visibility.published", "review.visibility.publishedNoTime"]);
    }
    // the view says it too: published needs an applied request whose read-back was public, whatever else is true
    const src = SRC("lib/visibilityRequest.ts");
    expect(src).toContain('request.after_privacy === "public" ? { kind: "published"');
    expect(src.match(/kind: "published"/g)).toHaveLength(2);   // the type and that one return
  });

  it.each(["en", "ru", "uz"] as const)("%s: every sentence of the switched-on flow says YouTube may still keep the video private and that the switch can be turned off", (loc) => {
    const d = dicts[loc];
    const keep = { en: /may still keep/, ru: /всё равно может оставить/, uz: /baribir shaxsiy qoldirishi mumkin/ }[loc];
    const off = { en: /switch(ed)? (it|this|the setting|“Publish when approved”) off/, ru: /выключить|отключить/, uz: /oʻchirib qoʻyish/ }[loc];
    for (const [name, s] of [
      ["review.queueHintPublish", d.review.queueHintPublish],
      ["confirmSheets.rvApprovePublishBody", d.confirmSheets.rvApprovePublishBody],
      ["confirmSheets.publishOnBody", d.confirmSheets.publishOnBody],
      ["channels.publishOnHintOn", d.channels.publishOnHintOn],
    ]) {
      expect(s, `${loc}.${name}`).toMatch(keep);
      expect(s, `${loc}.${name}`).toMatch(off);
    }
  });

  it.each(["en", "ru", "uz"] as const)("%s: the switch is explained as off by default, as recording a decision when off, and never as a certain outcome", (loc) => {
    const d = dicts[loc];
    const byDefault = { en: /Off by default/, ru: /По умолчанию выключено/, uz: /Standart boʻyicha oʻchiq/ }[loc];
    expect(d.channels.publishOnHintOff).toMatch(byDefault);
    expect(d.confirmSheets.publishOnBody).toMatch({ en: /off by default/, ru: /По умолчанию выключено/, uz: /Standart boʻyicha oʻchiq/ }[loc]);
    // the OFF state still says approving only records a decision (and the old sentence about the review panel is untouched)
    expect(d.channels.publishOnHintOff).toMatch({ en: /records your decision only/, ru: /только записывает ваше решение/, uz: /faqat qaroringizni yozib qoʻyadi/ }[loc]);
    const certain: Record<typeof loc, RegExp[]> = {
      en: [/(?<!not |nothing )will be published/i, /goes public (on its own|automatically)/i, /is published (automatically|when you approve)/i, /guarantee/i],
      ru: [/(?<!не )будет опубликован/i, /автоматически публикуется/i, /гарантир/i],
      uz: [/(?<!hech narsa )nashr qilinadi(?![\p{L}])/iu, /avtomatik nashr qilinadi/i, /kafolat/i],
    };
    for (const s of [d.review.queueHintPublish, d.confirmSheets.rvApprovePublishBody, d.confirmSheets.publishOnBody, d.channels.publishOnHintOn,
                     d.channels.publishOnHintOff, d.channels.autoOffHintPublish, d.review.visibility.queued, d.review.visibility.queuedHint]) {
      for (const re of certain[loc]) expect(s, `${loc}: ${s}`).not.toMatch(re);
    }
  });

  it("every reason word has a sentence in all three languages, none of them says published, and the retry errors are covered too", () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      const v = dicts[loc].review.visibility;
      expect(Object.keys(v.reasons).sort(), loc).toEqual([...VISIBILITY_REASONS].sort());
      expect(Object.keys(v.retryErrors).sort(), loc).toEqual([...RETRY_ERRORS, "failed"].sort());
      for (const s of [...Object.values(v.reasons), ...Object.values(v.retryErrors)]) {
        expect(s.trim().length, `${loc}: ${s}`).toBeGreaterThan(8);
        expect(s, `${loc}: ${s}`).not.toMatch(/(?<![\p{L}])(published|опубликован\p{L}*|nashr qilindi)(?![\p{L}])/iu);
      }
    }
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
