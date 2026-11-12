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

  // Paddle's seller verification reads the Terms for what is sold, who sells
  // it and how refunds work, and the Privacy Policy for who processes payments.
  const PADDLE_BUYER_TERMS = "https://www.paddle.com/legal/checkout-buyer-terms";
  const PADDLE_PRIVACY = "https://www.paddle.com/legal/privacy";

  for (const [locale, texts] of Object.entries(LEGAL_TEXTS)) {
    describe(`${locale}: prepaid credits and Paddle`, () => {
      const credits = texts.terms.sections.find((s) => s.id === "credits");
      const creditsText = credits ? credits.body.flatMap(strings).join(" ") : "";

      it("the credits section is in effect: a lawyer-review note on top, no template marker, no [blanks]", () => {
        expect(credits?.body[0]).toHaveProperty("note");
        expect(creditsText).not.toMatch(/TEMPLATE|NOT IN EFFECT|ШАБЛОН|НЕ ДЕЙСТВУЕТ|SHABLON|KUCHDA EMAS/);
        // A bracketed gap like "[N months]" would be an unfinished promise;
        // markdown links are the only brackets allowed.
        expect(creditsText.replace(/\[[^\]]+\]\([^)]+\)/g, "")).not.toMatch(/\[|\]/);
      });

      it("names Paddle as Merchant of Record and links its buyer terms, privacy notice and our pricing page", () => {
        expect(creditsText).toContain("Paddle");
        expect(creditsText).toContain("Merchant of Record");
        const links = hrefs(texts.terms);
        expect(links).toContain(PADDLE_BUYER_TERMS);
        expect(links).toContain(PADDLE_PRIVACY);
        expect(links).toContain("/pricing");
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

      it("lists Paddle among the Privacy Policy's processors, with its privacy notice", () => {
        const processors = texts.privacy.sections.find((s) => s.id === "processors");
        const table = processors?.body.find((b) => typeof b === "object" && "table" in b) as
          | { table: { rows: string[][] } }
          | undefined;
        expect(table?.table.rows.some((r) => r[0].startsWith("Paddle"))).toBe(true);
        expect(processors?.body.flatMap(strings).join(" ")).toContain("Merchant of Record");
        expect(hrefs(texts.privacy)).toContain(PADDLE_PRIVACY);
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

  it("English has the general rules (6.1) and the generated-content part (6.2 to 6.5), with the six prohibited kinds", () => {
    expect(shape("en")).toEqual(["6.1.", "list:6", "6.2.", "list:6", "text", "6.3.", "6.4.", "6.5."]);
    const text = textOf("en");
    for (const phrase of [
      "sexually suggestive",
      "sexualises or exploits minors",
      "real, identifiable person without that person’s explicit consent",
      "face swaps, deepfakes, voice cloning and voice impersonation",
      "impersonates a person or an organisation",
      "real footage",
      "infringes copyright, trademarks or other rights",
      "living artist’s protected work",
      "self-harm",
      "safety filters",
      "The Service does not offer face-swap or voice-cloning features.",
      "watermark",
      "provenance metadata",
      "A request a model refuses is not charged",
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

  // "A request a model refuses is not charged" leans on 8.3: a run that fails returns its whole hold.
  it.each(["en", "ru", "uz"] as const)("%s: 6.4 rests on 8.3, which still returns the whole hold of a failed run", (locale) => {
    const credits = LEGAL_TEXTS[locale].terms.sections.find((s) => s.id === "credits")!;
    const failed = { en: "If a run fails or does not complete, the whole hold is returned and nothing is charged.", ru: "весь резерв возвращается и ничего не списывается", uz: "band toʻliq qaytariladi va hech narsa yechilmaydi" }[locale];
    expect(credits.body.flatMap(strings).join(" ")).toContain(failed);
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
      }
      const seed = read("supabase/migrations/0137_character_studio.sql").match(/insert into public\.character_swap_models[\s\S]*?;/)?.[0] ?? "";
      expect(seed).toMatch(/kling-4\.0-omni-edit/);
      const rows = seed.match(/\('(?:kling|seedance)[^)]*\)/g) ?? [];
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.split(",")[2]?.trim(), row).toBe("null");
    });

    it("no deployed service runs the character-swap or voice-clone worker", () => {
      expect(read("deploy/docker-compose.yml")).not.toMatch(/character_swap_worker|voice_worker/);
    });
  });
});
