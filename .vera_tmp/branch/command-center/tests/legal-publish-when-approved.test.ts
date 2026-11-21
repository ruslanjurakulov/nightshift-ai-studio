/**
 * What the legal pages, the Google consent justification and the public pages say about "publish when approved" must be
 * what the feature does (docs/APPROVE_PUBLISH_1B.md): after a person approves one exact cut of an already uploaded PRIVATE
 * video, and only on a channel whose workspace administrator switched the setting on (per channel, off by default), a worker
 * asks YouTube once to change that video's visibility from private to public and records what a read-back reports. It
 * never changes title, description, tags or thumbnail, never deletes, never edits other videos, playlists or comments, and
 * it uses the scope the app already requests (youtube.force-ssl), so no scope is added.
 *
 * Before this change the same pages said "Nightshift never ... edits your existing videos" and "making a video public is
 * done on YouTube", which this feature makes false. This pins that those sentences are gone and that the new ones carry
 * the facts a reader needs: what changes, who must have acted, that it is off by default, and that nothing else is
 * edited or deleted.
 *
 * Do NOT merge before the feature is released: until then the Command Center hides the feature and these pages would
 * describe something customers cannot see.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGAL_TEXTS, type LegalBlock, type LegalDocument } from "@/lib/legal-docs";
import { dictionaries } from "@/lib/i18n";

const LOCALES = ["en", "ru", "uz"] as const;
type Loc = (typeof LOCALES)[number];
const REPO = join(__dirname, "..", "..");

function strings(block: LegalBlock): string[] {
  if (typeof block === "string") return [block];
  if ("list" in block) return block.list;
  if ("note" in block) return [block.note];
  if ("creditExpiry" in block) return [block.creditExpiry.never, block.creditExpiry.after];
  return [...block.table.head, ...block.table.rows.flat()];
}
const section = (doc: LegalDocument, id: string) => {
  const s = doc.sections.find((x) => x.id === id);
  if (!s) throw new Error(`no section ${id}`);
  return s.body.flatMap(strings).join("\n");
};
const scopeRow = (doc: LegalDocument, scope: string) => {
  const table = doc.sections.find((s) => s.id === "google-user-data")!.body.find((b) => typeof b === "object" && "table" in b) as {
    table: { rows: string[][] };
  };
  const row = table.table.rows.find((r) => r[0].includes(scope));
  if (!row) throw new Error(`no row for ${scope}`);
  return row[1];
};
/** Every string in a dictionary with the path it lives at, so a failure names the key to fix. */
function walk(node: unknown, path: string, out: [string, string][] = []): [string, string][] {
  if (typeof node === "string") out.push([path, node]);
  else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`, out));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`, out);
  return out;
}

/** The setting's name in each language, as the app itself spells it (lib/i18n/{en,ru,uz}.ts, review.visibility.title). */
const SETTING: Record<Loc, string> = {
  en: "“Publish when approved”",
  ru: "«Публиковать после одобрения»",
  uz: "“Tasdiqdan keyin nashr qilish”",
};
const OFF_BY_DEFAULT: Record<Loc, RegExp> = {
  en: /off by default/,
  ru: /по умолчанию выключен/,
  uz: /sukut boʻyicha oʻchiq/,
};
const MAY_STAY_PRIVATE: Record<Loc, RegExp> = {
  en: /YouTube may still keep the video private/,
  ru: /YouTube всё равно может оставить видео приватным/,
  uz: /YouTube videoni baribir yopiq qoldirishi mumkin/,
};
/** The legal texts may name the role. */
const ADMIN: Record<Loc, RegExp> = {
  en: /administrator of your workspace/,
  ru: /[Аа]дминистратор вашего рабочего пространства/,
  uz: /[Ii]sh maydoningiz administratori/,
};
/** Customer copy names no role (tests/simple-accounts.test.tsx), so the public pages say who in plain words. */
const WHO_PLAIN: Record<Loc, RegExp> = {
  en: /someone who manages (your|the) workspace/,
  ru: /тот, кто управляет (вашим |)рабочим пространством/,
  uz: /ish maydon\w* ?\w* boshqaradigan kishi/,
};
const NO_OTHER_EDITS: Record<Loc, RegExp> = {
  en: /title, description, tags or thumbnail/,
  ru: /название, описание, теги и обложк/,
  uz: /nomi, tavsifi, teglari va muqovasi/,
};

describe.each(LOCALES)("%s: the legal texts describe publish when approved", (loc) => {
  const { privacy, terms } = LEGAL_TEXTS[loc];

  it("the youtube.force-ssl row says what the scope now does: one visibility change, after a person approved, on a channel where it is switched on", () => {
    const row = scopeRow(privacy, "youtube.force-ssl");
    expect(row).toContain(SETTING[loc]);
    expect(row).toMatch(OFF_BY_DEFAULT[loc]);
    expect(row).toMatch(ADMIN[loc]);
    expect(row).toMatch(NO_OTHER_EDITS[loc]);
    expect(row).toMatch(/private|приватн|yopiq/);
    expect(row).toMatch(/public|публичн|ommaviy/);
  });

  it("the old sentence that Nightshift never edits existing videos, with nothing else said, is gone from both documents", () => {
    const all = [privacy, terms].flatMap((d) => d.sections.flatMap((s) => s.body.flatMap(strings))).join("\n");
    expect(all).not.toMatch(/never edits your existing videos, playlists or comments; it only adds the items listed here/);
    expect(all).not.toMatch(/не редактирует ваши существующие видео, плейлисты или комментарии; он только добавляет/);
    expect(all).not.toMatch(/mavjud videolaringiz, pleylistlaringiz yoki izohlaringizni tahrirlamaydi; u faqat shu yerda/);
  });

  it("the youtube.upload row still says uploads are private and now says an approved one can be made public only where the setting is on", () => {
    const row = scopeRow(privacy, "youtube.upload");
    expect(row).toContain(SETTING[loc]);
    expect(row).toMatch(OFF_BY_DEFAULT[loc]);
  });

  it("section 4 of the Privacy Policy lists making an approved video public as a feature and explains it in one paragraph", () => {
    const text = section(privacy, "how-we-use-google-data");
    expect(text).toContain(SETTING[loc]);
    expect(text).toMatch(OFF_BY_DEFAULT[loc]);
    expect(text).toMatch(ADMIN[loc]);
    expect(text).toMatch(MAY_STAY_PRIVATE[loc]);
    expect(text).toMatch(NO_OTHER_EDITS[loc]);
    expect(text).toMatch(/24/); // the approval lasts 24 hours
  });

  it("Limited Use is untouched: it still ties every use to the features described above, and adds no purpose of its own", () => {
    const lim = section(privacy, "limited-use");
    expect(lim).toContain("developers.google.com/terms/api-services-user-data-policy");
    expect(lim).not.toContain(SETTING[loc]);
  });

  it("the Terms say what approving does on such a channel, that it is off by default, and that responsibility is the existing one", () => {
    const text = section(terms, "youtube");
    expect(text).toContain(SETTING[loc]);
    expect(text).toMatch(OFF_BY_DEFAULT[loc]);
    expect(text).toMatch(ADMIN[loc]);
    expect(text).toMatch(MAY_STAY_PRIVATE[loc]);
    expect(text).toMatch(NO_OTHER_EDITS[loc]);
    expect(text).toMatch(/5/); // section 5 (your content and your responsibility) applies
  });

  it("credits and refunds are not mentioned: the feature spends YouTube quota, not credits, and the lawyer-review note stays", () => {
    const credits = terms.sections.find((s) => s.id === "credits")!;
    expect(credits.body[0]).toHaveProperty("note");
    expect(section(terms, "credits")).not.toContain(SETTING[loc]);
  });
});

describe("the public pages no longer say that going public is only ever done on YouTube", () => {
  const OLD: Record<Loc, RegExp[]> = {
    en: [
      /Making (it|one|a video) public is done on YouTube/,
      /making a video public is done on YouTube/,
      /Going public is your decision, made on YouTube/,
      /It goes public only when you make it public on YouTube\.?$/,
      /You watch it, then make it public on YouTube\.$/,
    ],
    ru: [/Сделать видео публичным можно на YouTube\.(?!\S)/, /Сделать видео публичным решаете вы, на YouTube/, /В эфир — только когда вы сделаете его публичным на YouTube\.$/],
    uz: [/Ommaviy qilish YouTube’da bajariladi/, /ommaviy qilish YouTube’da bajariladi/, /Ommaviy qilishni siz hal qilasiz, YouTube’da/],
  };
  it.each(LOCALES)("%s", (loc) => {
    const hits: string[] = [];
    for (const [path, s] of walk(dictionaries[loc], loc)) for (const re of OLD[loc]) if (re.test(s)) hits.push(`${path}: ${re}`);
    expect(hits).toEqual([]);
  });

  it.each(LOCALES)("%s: the rewritten sentences name the setting, and none of them says it publishes without a person", (loc) => {
    const mentioning = walk(dictionaries[loc], loc).filter(([, s]) => s.includes(SETTING[loc]));
    // the landing, the Studio page, the Solutions pages, the home page and the accounts note were each rewritten
    expect(mentioning.length).toBeGreaterThanOrEqual(10);
    for (const [path, s] of mentioning) {
      expect(s, `${path}: ${s}`).not.toMatch(/automatically|publishes on its own and|автоматически публикуется|oʻz-oʻzidan nashr/i);
    }
  });

  it.each(LOCALES)("%s: the public site copy says who switches the setting on, in plain words", (loc) => {
    const text = walk(dictionaries[loc].site, `${loc}.site`).map(([, s]) => s).join("\n");
    expect(text).toContain(SETTING[loc]);
    expect(text).toMatch(WHO_PLAIN[loc]);
  });
});

describe("docs/GOOGLE_OAUTH_VERIFICATION.md", () => {
  const doc = readFileSync(join(REPO, "docs", "GOOGLE_OAUTH_VERIFICATION.md"), "utf8");
  it("no longer says Nightshift never edits existing videos, and names videos.update, its two conditions and that no scope was added", () => {
    expect(doc).not.toContain("Nightshift never deletes or edits existing videos, playlists or comments.");
    expect(doc).toContain("videos.update");
    expect(doc).toContain('"Publish when approved"');
    expect(doc).toMatch(/off by default for every channel/);
    expect(doc).toMatch(/status\.privacyStatus = public/);
    expect(doc).toMatch(/never changes a video's title, description, tags or thumbnail/);
    expect(doc).toMatch(/yangi scope emas/);
  });
  it("the demo video script shows the switch, the typed confirmation, the approval, the queued state and the video public in Studio", () => {
    for (const step of ["Channels sahifasida", "yozilgan so'z", "shu aniq versiyani tasdiqlash", "Queued", "YouTube Studio'da video *Private*dan *Public*ga"]) {
      expect(doc, step).toContain(step);
    }
  });
  it("the audit and quota step names the cost of the write and says what is not confirmed", () => {
    expect(doc).toMatch(/50 birlik/);
    expect(doc).toMatch(/platform_kept_private/);
    expect(doc).toMatch(/tasdiqlanmagan/);
  });
});
