import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGAL_TEXTS, type LegalBlock, type LegalDocument } from "@/lib/legal-docs";
import { tokenizeInline } from "@/lib/legal-docs/inline";
import { bannedHits } from "@/lib/marketing-banned";
import { characterStudioEnabled } from "@/lib/characterStudio/model";
import { customVoiceEnabled } from "@/lib/custom-voice";
import { PROVIDER_BRANDS } from "./helpers/brands";

function strings(block: LegalBlock): string[] {
  if (typeof block === "string") return [block];
  if ("list" in block) return block.list;
  if ("note" in block) return [block.note];
  if ("creditExpiry" in block) return [block.creditExpiry.never, block.creditExpiry.after];
  return [...block.table.head, ...block.table.rows.flat()];
}

function allText(doc: LegalDocument): string[] {
  return [doc.title, doc.summary, ...doc.sections.flatMap((s) => [s.heading, ...s.body.flatMap(strings)])];
}

function hrefs(doc: LegalDocument): string[] {
  return allText(doc)
    .flatMap(tokenizeInline)
    .flatMap((tok) => (tok.kind === "link" ? [tok.href] : []))
    .sort();
}

function codes(doc: LegalDocument): string[] {
  return allText(doc)
    .flatMap(tokenizeInline)
    .flatMap((tok) => (tok.kind === "code" ? [tok.text] : []))
    .sort();
}

describe("inline markup", () => {
  it("splits links, operator placeholders and code out of the text", () => {
    expect(tokenizeInline("Email {contactEmail} or read [the policy](/privacy) on `youtube.upload`.")).toEqual([
      { kind: "text", text: "Email " },
      { kind: "var", name: "contactEmail" },
      { kind: "text", text: " or read " },
      { kind: "link", label: "the policy", href: "/privacy" },
      { kind: "text", text: " on " },
      { kind: "code", text: "youtube.upload" },
      { kind: "text", text: "." },
    ]);
  });

  // A typo'd placeholder must stay visible on the page, not vanish silently.
  it("leaves an unknown {placeholder} as text", () => {
    expect(tokenizeInline("by {legalNmae}")).toEqual([{ kind: "text", text: "by {legalNmae}" }]);
  });

  it("does not turn a non-https link into an anchor", () => {
    expect(tokenizeInline("[x](javascript:alert(1))").every((t) => t.kind === "text")).toBe(true);
  });
});

describe("legal texts", () => {
  const { en } = LEGAL_TEXTS;

  // Google's reviewers check for these; losing one in an edit fails verification.
  it("the Privacy Policy carries the links YouTube API Services require", () => {
    const links = hrefs(en.privacy);
    expect(links).toContain("https://www.youtube.com/t/terms");
    expect(links).toContain("https://policies.google.com/privacy");
    expect(links).toContain("https://myaccount.google.com/permissions");
    expect(links).toContain("https://developers.google.com/terms/api-services-user-data-policy");
    expect(allText(en.privacy).join(" ")).toContain("Limited Use requirements");
  });

  it("the Privacy Policy names every scope the connect flow requests", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../lib/server/google-oauth.ts", import.meta.url), "utf8"),
    );
    const requested = [...src.matchAll(/"https:\/\/www\.googleapis\.com\/auth\/([\w.-]+)"/g)].map((m) => m[1]);
    expect(requested.length).toBeGreaterThan(0);
    const named = codes(en.privacy).map((c) => c.replace(/\s*\(.*\)$/, ""));
    for (const scope of requested) expect(named).toContain(scope);
  });

  // The merchant of record's reviewers (Dodo Payments) read the Terms for what is sold, who sells it and how
  // refunds work, and the Privacy Policy for who processes payments. Paddle is named only as the sandbox test
  // checkout that is still in the code until the Dodo checkout replaces it.
  const DODO_BUYER_TERMS = "https://dodopayments.com/legal/buyer-terms";
  const DODO_PRIVACY = "https://dodopayments.com/legal/privacy-policy";
  const DODO_COOKIES = "https://dodopayments.com/legal/cookie-policy";

  for (const [locale, texts] of Object.entries(LEGAL_TEXTS)) {
    describe(`${locale}: prepaid credits and Dodo Payments`, () => {
      const credits = texts.terms.sections.find((s) => s.id === "credits");
      const creditsText = credits ? credits.body.flatMap(strings).join(" ") : "";

      it("the credits section is in effect: a lawyer-review note on top, no template marker, no [blanks]", () => {
        expect(credits?.body[0]).toHaveProperty("note");
        expect(creditsText).not.toMatch(/TEMPLATE|NOT IN EFFECT|ШАБЛОН|НЕ ДЕЙСТВУЕТ|SHABLON|KUCHDA EMAS/);
        // A bracketed gap like "[N months]" would be an unfinished promise;
        // markdown links are the only brackets allowed.
        expect(creditsText.replace(/\[[^\]]+\]\([^)]+\)/g, "")).not.toMatch(/\[|\]/);
      });

      it("names Dodo Payments as Merchant of Record, links its buyer terms, privacy policy and our pricing page", () => {
        expect(creditsText).toContain("Dodo Payments");
        expect(creditsText).toContain("Merchant of Record");
        const links = hrefs(texts.terms);
        expect(links).toContain(DODO_BUYER_TERMS);
        expect(links).toContain(DODO_PRIVACY);
        expect(links).toContain("/pricing");
        // Paddle declined the account: the Terms link none of its pages and name it only as the sandbox test checkout.
        expect(links.filter((l) => l.includes("paddle"))).toEqual([]);
        const s82 = credits!.body.flatMap(strings).find((s) => s.startsWith("8.2."))!;
        expect(s82).toMatch(/Paddle[^.]*\(sandbox\)/);
      });

      // Unset expiry means "credits do not expire" — what the system does —
      // so both wordings must exist, and only the configured one fills {months}.
      it("says what happens with and without an expiry term", () => {
        const expiry = credits?.body.find((b) => typeof b === "object" && "creditExpiry" in b);
        expect(expiry).toBeDefined();
        const { never, after } = (expiry as { creditExpiry: { never: string; after: string } }).creditExpiry;
        expect(never).not.toContain("{months}");
        expect(after).toContain("{months}");
      });

      it("lists Dodo Payments among the Privacy Policy's processors, with its privacy policy, and Paddle only as the test checkout", () => {
        const processors = texts.privacy.sections.find((s) => s.id === "processors");
        const table = processors?.body.find((b) => typeof b === "object" && "table" in b) as
          | { table: { rows: string[][] } }
          | undefined;
        expect(table?.table.rows.some((r) => r[0].startsWith("Dodo Payments"))).toBe(true);
        const paddle = table?.table.rows.filter((r) => r[0].startsWith("Paddle")) ?? [];
        expect(paddle).toHaveLength(1);
        expect(paddle[0].join(" ")).toContain("sandbox");
        expect(processors?.body.flatMap(strings).join(" ")).toContain("Merchant of Record");
        expect(hrefs(texts.privacy)).toContain(DODO_PRIVACY);
        expect(hrefs(texts.privacy)).toContain(DODO_COOKIES);
      });
    });
  }

  for (const [locale, texts] of Object.entries(LEGAL_TEXTS)) {
    if (locale === "en") continue;
    describe(locale, () => {
      for (const kind of ["privacy", "terms", "refund"] as const) {
        it(`${kind}: has the same sections, links and scopes as English`, () => {
          expect(texts[kind].sections.map((s) => s.id)).toEqual(en[kind].sections.map((s) => s.id));
          expect(hrefs(texts[kind])).toEqual(hrefs(en[kind]));
          expect(codes(texts[kind])).toEqual(codes(en[kind]));
        });
      }
    });
  }
});

/**
 * Terms section 6, generated content (6.2-6.5). Payment providers that accept AI content tools do so only with
 * rules against sexual content, deepfakes, face swaps, voice cloning, impersonation and infringement, and their
 * reviewers read the Terms for them. The rules must say the same thing in every language, in the same shape, and
 * the one statement about the product ("does not offer face-swap or voice-cloning features") must stay true.
 */
describe("Terms 6: generated images, video and voice", () => {
  const section = (locale: keyof typeof LEGAL_TEXTS) => LEGAL_TEXTS[locale].terms.sections.find((s) => s.id === "acceptable-use")!;
  const shape = (locale: keyof typeof LEGAL_TEXTS) =>
    section(locale).body.map((b) => (typeof b === "string" ? (b.match(/^\d+\.\d+\./)?.[0] ?? "text") : "list" in b ? `list:${b.list.length}` : "other"));
  const textOf = (locale: keyof typeof LEGAL_TEXTS) => section(locale).body.flatMap(strings).join(" ");

  it("English has the general rules (6.1) and the generated-content part (6.2 to 6.6), with the six prohibited kinds", () => {
    expect(shape("en")).toEqual(["6.1.", "list:6", "6.2.", "list:6", "text", "6.3.", "6.4.", "6.5.", "6.6.", "list:4"]);
    const text = textOf("en");
    for (const phrase of [
      "sexually suggestive",
      "sexualises or exploits minors",
      "real, identifiable person without that person’s explicit consent",
      "face swaps, deepfakes, voice cloning and voice impersonation",
      "impersonates a person or an organisation",
      "real footage",
      "infringes copyright, trademarks or other rights",
      "someone else’s protected work",
      "self-harm",
      "safety filters",
      "The Service does not offer face-swap or voice-cloning features.",
      "watermark",
      "provenance metadata",
      "You are not charged for a request a model refuses",
      "the credits held for it are returned",
      "Child sexual abuse material is never allowed",
      "National Center for Missing & Exploited Children (NCMEC)",
      "6.6. Copyright notices.",
      "good faith",
      "{contactEmail}",
      "section 13",
    ]) expect(text, phrase).toContain(phrase);
  });

  it.each(["ru", "uz"] as const)("%s has the same parts, in the same order, with the same number of rules", (locale) => {
    expect(shape(locale)).toEqual(shape("en"));
    const text = textOf(locale);
    expect(text).toContain("{contactEmail}");
    expect(text).toMatch(/13/);
    expect(text).toMatch(/8\.3/);
  });

  // "You are not charged for a request a model refuses" leans on 8.3: a run that fails, and a Studio generation that
  // fails or is refused, return their whole hold (modules/creative_worker.py, 0036 / 0126 finish_creative_job); a region
  // edit charges only the regions applied (0126). 8.3 must keep saying each of these.
  it.each(["en", "ru", "uz"] as const)("%s: 6.4 rests on 8.3, which returns the whole hold of a failed run or a refused generation", (locale) => {
    const credits = LEGAL_TEXTS[locale].terms.sections.find((s) => s.id === "credits")!;
    const text = credits.body.flatMap(strings).join(" ");
    const phrases = {
      en: [
        "If a run fails or does not complete, the whole hold is returned and nothing is charged.",
        "For a generation:",
        "If a generation fails, is refused by the model, is cancelled or is not finished in time, the whole hold is returned and nothing is charged.",
        "charged only for the areas actually applied: the share of the hold for the areas applied, rounded up to the nearest hundredth of a credit.",
      ],
      ru: ["весь резерв возвращается и ничего не списывается", "Для генерации:", "отклонена моделью", "только за фактически применённые области", "доля резерва за применённые области, округлённая вверх до сотой доли кредита"],
      uz: ["band toʻliq qaytariladi va hech narsa yechilmaydi", "Generatsiya uchun:", "model uni rad etsa", "faqat haqiqatda qoʻllangan sohalar uchun", "qoʻllangan sohalar uchun bandning ulushi, kreditning yuzdan bir qismigacha yuqoriga yaxlitlangan holda"],
    }[locale];
    for (const p of phrases) expect(text, p).toContain(p);
  });

  it.each(["ru", "uz"] as const)("%s: 8.3 has the same parts as English (a run list, a generation list)", (locale) => {
    const parts = (l: keyof typeof LEGAL_TEXTS) =>
      LEGAL_TEXTS[l].terms.sections.find((s) => s.id === "credits")!.body.map((b) =>
        typeof b === "string" ? (b.match(/^\d+\.\d+\./)?.[0] ?? "text") : "list" in b ? `list:${b.list.length}` : Object.keys(b)[0],
      );
    expect(parts(locale)).toEqual(parts("en"));
  });

  it.each(["en", "ru", "uz"] as const)("%s: section 6 names no model maker and uses no banned marketing word", (locale) => {
    const text = textOf(locale);
    expect(text).not.toMatch(PROVIDER_BRANDS);
    expect(bannedHits({ [locale]: text })).toEqual([]);
  });

  // If one of these fails, a face-swap or voice-cloning feature is on its way to customers: change Terms 6.2 first.
  describe("the product offers no face-swap or voice-cloning feature", () => {
    const ROOT = join(__dirname, "..", "..");
    const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

    it("Character Studio and the custom-voice page are off unless switched on, and the deploy templates leave both switches empty", () => {
      expect(characterStudioEnabled("")).toBe(false);
      expect(customVoiceEnabled({})).toBe(false);
      expect(read("deploy/.env.web.example")).toMatch(/^NIGHTSHIFT_CHARACTER_STUDIO=$/m);
      expect(read("deploy/.env.web.example")).toMatch(/^CUSTOM_VOICE_ENABLED=$/m);
      expect(read("deploy/.env.worker.example")).toMatch(/^NIGHTSHIFT_VOICE_CLONING=$/m);
    });

    it("no migration lets a signed-in user start a voice clone, and no character-swap model is seeded with a price", () => {
      const dir = join(ROOT, "supabase", "migrations");
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
        const sql = readFileSync(join(dir, f), "utf8");
        expect(sql, f).not.toMatch(/grant\s+execute\s+on\s+function\s+public\.request_voice_clone[^;]*\bto\b[^;]*\bauthenticated\b/i);
        // No migration may put a character-swap model on sale: no non-null credits_per_usd, written by an update or an insert.
        // (Comments are dropped first: 0137 shows the owner's own update statement in a comment.)
        const code = sql.replace(/--[^\n]*/g, "");
        expect(code, f).not.toMatch(/update\s+public\.character_swap_models\s+set[^;]*\bcredits_per_usd\s*=\s*(?!null\b)/i);
        for (const ins of code.match(/insert\s+into\s+public\.character_swap_models[\s\S]*?;/gi) ?? []) {
          const cols = ins.match(/\(([^)]*)\)/)?.[1].split(",").map((c) => c.trim()) ?? [];
          const at = cols.indexOf("credits_per_usd");
          expect(at, `${f}: an insert into character_swap_models names credits_per_usd`).toBeGreaterThanOrEqual(0);
          for (const row of ins.match(/\('[^)]*\)/g) ?? []) expect(row.slice(1, -1).split(",")[at]?.trim(), `${f}: ${row}`).toBe("null");
        }
      }
      const seed = read("supabase/migrations/0137_character_studio.sql").match(/insert into public\.character_swap_models[\s\S]*?;/)?.[0] ?? "";
      expect(seed).toMatch(/kling-4\.0-omni-edit/);
      const rows = seed.match(/\('(?:kling|seedance)[^)]*\)/g) ?? [];
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.split(",")[2]?.trim(), row).toBe("null");
    });

    // Dubbing keeps each speaker's own voice and voice change re-voices a recording: in effect voice cloning. Today only a
    // vendor-terms gate keeps them (and the character-swap models) out of sellable_models(); clearing one must change Terms 6.2 first.
    it("every registry entry that dubs, changes a voice or swaps a character carries a terms gate", () => {
      const registry = JSON.parse(read("schemas/model_registry.json")) as { models: { id: string; capabilities: string[]; terms_gate?: string | null }[] };
      const risky = registry.models.filter((m) => m.capabilities.some((c) => ["dub", "voice_change", "video_character_swap"].includes(c)));
      expect(risky.length).toBeGreaterThan(0);
      for (const m of risky) expect(String(m.terms_gate ?? "").trim(), m.id).not.toBe("");
    });

    it("no deployed service runs the character-swap or voice-clone worker", () => {
      expect(read("deploy/docker-compose.yml")).not.toMatch(/character_swap_worker|voice_worker/);
    });
  });
});
